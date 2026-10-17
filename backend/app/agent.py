"""
Agent Loop Module for TaskPilot Graph.
Supports both Gemini LLM tool-calling (via httpx REST) and deterministic graph fallback.
All actions and drafted reminders are persisted strictly in FalkorDB as (:Action) nodes.
"""

import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import httpx

from app.graph import (
    get_graph,
    find_overdue_tasks as graph_find_overdue_tasks,
    rank_overdue_by_impact as graph_rank_overdue_by_impact,
    save_pending_action,
)
from app.tools import (
    get_tasks as tool_get_tasks,
    find_overdue_tasks as tool_find_overdue_tasks,
    get_blocked_downstream as tool_get_blocked_downstream,
    rank_overdue_by_impact as tool_rank_overdue_by_impact,
    get_task_owner as tool_get_task_owner,
    find_helpers as tool_find_helpers,
    draft_reminder as tool_draft_reminder,
)

logger = logging.getLogger("taskpilot.agent")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

SYSTEM_INSTRUCTION = (
    "You are TaskPilot Graph AI, an intelligent agent acting on connected project data.\n"
    "Your objective is to proactively audit project health, detect overdue tasks, evaluate "
    "downstream dependency impact through graph traversal, and draft targeted reminder actions.\n"
    "Rules:\n"
    "1. Always inspect the graph using your available tools.\n"
    "2. Rank overdue tasks by downstream blocked impact.\n"
    "3. For tasks needing reminders, use draft_reminder to prepare a message with manager CC and helper options.\n"
    "4. Reminders are proposals: human approval is strictly required before any action is executed.\n"
    "5. Conclude with a clear, concise summary of the graph context and drafted actions."
)

GEMINI_TOOL_DECLARATIONS = [
    {
        "name": "get_tasks",
        "description": "List all tasks in the project graph with owners and projects.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "find_overdue_tasks",
        "description": "Find tasks whose deadline is before today UTC and status != 'Done'.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "get_blocked_downstream",
        "description": "Traverse multi-hop DEPENDS_ON paths to find all downstream tasks blocked by task_id.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "task_id": {"type": "INTEGER", "description": "The positive integer ID of the task."}
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "rank_overdue_by_impact",
        "description": "Rank overdue tasks by the number of downstream tasks they block, then days overdue.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "get_task_owner",
        "description": "Find task owner, email, and management escalation chain via REPORTS_TO.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "task_id": {"type": "INTEGER", "description": "The positive integer ID of the task."}
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "find_helpers",
        "description": "Find colleagues who worked on the same project who could help unblock the task.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "task_id": {"type": "INTEGER", "description": "The positive integer ID of the task."}
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "draft_reminder",
        "description": "Draft a context-aware reminder with blocked tasks, helper suggestions, and manager CC.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "task_id": {"type": "INTEGER", "description": "The positive integer ID of the task."}
            },
            "required": ["task_id"],
        },
    },
]


def _execute_tool(name: str, args: Dict[str, Any], graph=None) -> Dict[str, Any]:
    g = graph or get_graph()
    if name == "get_tasks":
        return tool_get_tasks(g)
    elif name == "find_overdue_tasks":
        return tool_find_overdue_tasks(g)
    elif name == "get_blocked_downstream":
        return tool_get_blocked_downstream(int(args.get("task_id", 0)), g)
    elif name == "rank_overdue_by_impact":
        return tool_rank_overdue_by_impact(g)
    elif name == "get_task_owner":
        return tool_get_task_owner(int(args.get("task_id", 0)), g)
    elif name == "find_helpers":
        return tool_find_helpers(int(args.get("task_id", 0)), g)
    elif name == "draft_reminder":
        return tool_draft_reminder(int(args.get("task_id", 0)), g)
    else:
        return {"error": f"Unknown tool: {name}"}


async def run_agent(graph=None, force_deterministic: bool = False) -> Dict[str, Any]:
    """
    Executes the TaskPilot agent cycle.
    If GEMINI_API_KEY is available and not force_deterministic, runs the Gemini REST tool calling loop.
    Otherwise, runs the deterministic FalkorDB graph-powered loop.
    """
    g = graph or get_graph()
    api_key = os.getenv("GEMINI_API_KEY", "").strip()

    if api_key and not force_deterministic:
        try:
            return await _run_gemini_agent(api_key, g)
        except Exception as e:
            logger.warning("Gemini agent loop failed, falling back to deterministic graph execution: %s", e)
            return _run_deterministic_agent(g, fallback_reason=str(e))
    else:
        return _run_deterministic_agent(g)


def _run_deterministic_agent(graph, fallback_reason: Optional[str] = None) -> Dict[str, Any]:
    """
    Deterministic FalkorDB graph analysis:
    1. Fetches overdue tasks and ranks them by downstream impact.
    2. For any overdue task without a reminderSent, drafts a context-aware reminder.
    3. Persists each drafted reminder as an (:Action) node in FalkorDB.
    4. Compiles structured response compatible with dashboard expectations.
    """
    now_utc = datetime.now(timezone.utc)
    today_utc = now_utc.strftime("%Y-%m-%d")
    now_iso = now_utc.isoformat()

    trace = [
        {"step": "init", "mode": "deterministic", "timestamp": now_iso},
        {"step": "evaluate_overdue", "todayUtc": today_utc},
    ]

    # 1. Fetch overdue
    overdue_tasks = graph_find_overdue_tasks(graph, today_utc)
    trace.append({"step": "found_overdue", "count": len(overdue_tasks), "taskIds": [t["id"] for t in overdue_tasks]})

    # 2. Rank by impact
    ranked_tasks = graph_rank_overdue_by_impact(graph, today_utc)
    trace.append({
        "step": "ranked_by_impact",
        "ranking": [{"taskId": r["taskId"], "blocksCount": r["blocksCount"]} for r in ranked_tasks],
    })

    # 3. Draft reminders for overdue tasks that haven't had reminders sent
    actions = []
    reasoning_lines = [
        f"Evaluated {len(overdue_tasks)} overdue tasks against FalkorDB graph data as of UTC {today_utc}."
    ]
    if fallback_reason:
        reasoning_lines.append(f"Notice: Deterministic graph mode active ({fallback_reason}).")

    for r in ranked_tasks:
        task_id = r["taskId"]
        if r["reminderSent"]:
            reasoning_lines.append(f"Task {task_id} ('{r['name']}'): reminder already sent. Skipping.")
            continue

        draft = tool_draft_reminder(task_id, graph=graph)
        action_id = f"act_{task_id}_{int(now_utc.timestamp())}_{uuid.uuid4().hex[:6]}"

        save_pending_action(
            graph=graph,
            action_id=action_id,
            task_id=task_id,
            owner=draft["owner"],
            email=draft["email"],
            task_name=draft["taskName"],
            message=draft["draftMessage"],
            created_at_iso=now_iso,
        )

        action_record = {
            "id": action_id,
            "actionId": action_id,
            "taskId": task_id,
            "taskName": draft["taskName"],
            "owner": draft["owner"],
            "email": draft["email"],
            "managerCc": draft.get("managerCc"),
            "message": draft["draftMessage"],
            "createdAt": now_iso,
            "state": "pending",
            "blocksCount": draft.get("blockedCount", 0),
        }
        actions.append(action_record)

        trace.append({
            "step": "draft_reminder",
            "taskId": task_id,
            "actionId": action_id,
            "blocksCount": draft.get("blockedCount", 0),
        })

        reasoning_lines.append(
            f"Task {task_id} ('{r['name']}'): Blocks {r['blocksCount']} downstream tasks. "
            f"Drafted reminder for {draft['owner']} (CC: {draft.get('managerCc') or 'None'}). Action ID: {action_id}."
        )

    summary = (
        f"Analyzed {len(overdue_tasks)} overdue tasks in FalkorDB. "
        f"Ranked {len(ranked_tasks)} by downstream impact. "
        f"Prepared {len(actions)} pending reminder actions requiring human approval."
    )

    return {
        "mode": "deterministic",
        "overdue": overdue_tasks,
        "ranked": ranked_tasks,
        "actions": actions,
        "reasoning": "\n".join(reasoning_lines),
        "trace": trace,
        "summary": summary,
    }


async def _run_gemini_agent(api_key: str, graph) -> Dict[str, Any]:
    """
    Executes multi-turn Gemini agent loop over HTTP REST with tool-calling.
    Hard cap of 6 iterations.
    """
    now_utc = datetime.now(timezone.utc)
    today_utc = now_utc.strftime("%Y-%m-%d")
    now_iso = now_utc.isoformat()

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={api_key}"
    headers = {"Content-Type": "application/json"}

    contents: List[Dict[str, Any]] = [
        {
            "role": "user",
            "parts": [
                {
                    "text": (
                        f"Current UTC date is {today_utc}. Please audit the project graph for overdue tasks, "
                        "evaluate their downstream impact on other tasks, identify the most critical blockers, "
                        "and draft reminders for the owners where appropriate."
                    )
                }
            ],
        }
    ]

    tools_spec = [{"functionDeclarations": GEMINI_TOOL_DECLARATIONS}]
    system_spec = {"parts": [{"text": SYSTEM_INSTRUCTION}]}

    trace = [{"step": "gemini_start", "model": GEMINI_MODEL, "timestamp": now_iso}]
    actions: List[Dict[str, Any]] = []
    final_text = ""

    async with httpx.AsyncClient(timeout=30.0) as client:
        for iteration in range(1, 7):
            payload = {
                "contents": contents,
                "tools": tools_spec,
                "systemInstruction": system_spec,
            }
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code != 200:
                raise RuntimeError(f"Gemini API returned HTTP {resp.status_code}: {resp.text}")

            data = resp.json()
            candidates = data.get("candidates", [])
            if not candidates:
                break

            candidate = candidates[0]
            content = candidate.get("content", {})
            parts = content.get("parts", [])
            contents.append(content)

            function_calls = [p["functionCall"] for p in parts if "functionCall" in p]
            text_parts = [p["text"] for p in parts if "text" in p]
            if text_parts:
                final_text += "\n".join(text_parts)

            if not function_calls:
                # LLM finished calling tools
                break

            # Execute all function calls requested in this turn
            tool_response_parts = []
            for fc in function_calls:
                fn_name = fc.get("name")
                fn_args = fc.get("args", {})
                result = _execute_tool(fn_name, fn_args, graph=graph)

                trace.append({
                    "step": "tool_call",
                    "iteration": iteration,
                    "tool": fn_name,
                    "args": fn_args,
                    "evidence": result.get("evidence", []),
                })

                # If draft_reminder was called, persist Action node in FalkorDB
                if fn_name == "draft_reminder" and "draftMessage" in result:
                    task_id = result.get("taskId")
                    action_id = f"act_{task_id}_{int(now_utc.timestamp())}_{uuid.uuid4().hex[:6]}"
                    save_pending_action(
                        graph=graph,
                        action_id=action_id,
                        task_id=task_id,
                        owner=result.get("owner", "Owner"),
                        email=result.get("email", ""),
                        task_name=result.get("taskName", ""),
                        message=result.get("draftMessage", ""),
                        created_at_iso=now_iso,
                    )
                    action_record = {
                        "id": action_id,
                        "actionId": action_id,
                        "taskId": task_id,
                        "taskName": result.get("taskName"),
                        "owner": result.get("owner"),
                        "email": result.get("email"),
                        "managerCc": result.get("managerCc"),
                        "message": result.get("draftMessage"),
                        "createdAt": now_iso,
                        "state": "pending",
                        "blocksCount": result.get("blockedCount", 0),
                    }
                    actions.append(action_record)
                    result["actionId"] = action_id

                tool_response_parts.append({
                    "functionResponse": {
                        "name": fn_name,
                        "response": {"output": result},
                    }
                })

            contents.append({"role": "user", "parts": tool_response_parts})

    # Fetch ground truth overdue and ranked tasks from FalkorDB for consistent schema
    overdue_tasks = graph_find_overdue_tasks(graph, today_utc)
    ranked_tasks = graph_rank_overdue_by_impact(graph, today_utc)

    summary = (
        final_text.strip()
        or f"Gemini agent audited graph, identified {len(overdue_tasks)} overdue tasks, and generated {len(actions)} actions."
    )

    return {
        "mode": "gemini",
        "overdue": overdue_tasks,
        "ranked": ranked_tasks,
        "actions": actions,
        "reasoning": final_text.strip() or "Gemini reasoning captured in conversation trace.",
        "trace": trace,
        "summary": summary,
    }
