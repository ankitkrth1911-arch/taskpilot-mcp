"""
Tools Module for TaskPilot Graph.
Implements the 8 core tools (and optional PageRank criticality tool)
powered strictly by FalkorDB Cypher queries.

All tools return rich structured data accompanied by an 'evidence' field
that traces the exact graph nodes and relationships traversed.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.graph import (
    get_graph,
    get_all_tasks,
    get_task_by_id,
    find_overdue_tasks as graph_find_overdue_tasks,
    get_blocked_downstream as graph_get_blocked_downstream,
    rank_overdue_by_impact as graph_rank_overdue_by_impact,
    get_task_owner_and_escalation,
    find_helpers as graph_find_helpers,
    update_task_status as graph_update_task_status,
    page_rank_criticality,
)


def _get_today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def get_tasks(graph=None) -> Dict[str, Any]:
    """
    Tool 1: get_tasks()
    Retrieves all tasks in the graph with their owners and project assignments.
    """
    g = graph or get_graph()
    tasks = get_all_tasks(g)
    return {
        "tasks": tasks,
        "count": len(tasks),
        "evidence": [f"Retrieved {len(tasks)} tasks via (t:Task) MATCH with [:OWNS] and [:IN_PROJECT]"],
    }


def find_overdue_tasks(graph=None) -> Dict[str, Any]:
    """
    Tool 2: find_overdue_tasks()
    Identifies all tasks with deadline < today UTC and status != 'Done'.
    """
    g = graph or get_graph()
    today_utc = _get_today_utc()
    overdue = graph_find_overdue_tasks(g, today_utc)
    evidence = [
        f"Evaluated tasks against UTC date {today_utc}",
        f"Found {len(overdue)} overdue tasks with status != 'Done'",
    ]
    for t in overdue:
        evidence.append(f"Task {t['id']} ('{t['name']}'): deadline {t['deadline']} is {t['daysOverdue']} days overdue (Owner: {t['owner']})")

    return {
        "todayUtc": today_utc,
        "overdueTasks": overdue,
        "count": len(overdue),
        "evidence": evidence,
    }


def get_blocked_downstream(task_id: int, graph=None) -> Dict[str, Any]:
    """
    Tool 3: get_blocked_downstream(task_id)
    Traverses multi-hop DEPENDS_ON relationships to find all downstream tasks blocked by task_id.
    """
    if not isinstance(task_id, int) or task_id <= 0:
        return {"error": "Invalid task_id: must be a positive integer"}

    g = graph or get_graph()
    task = get_task_by_id(g, task_id)
    if not task:
        return {"error": f"Task {task_id} not found in graph"}

    blocked = graph_get_blocked_downstream(g, task_id)
    evidence = [
        f"Target Task {task_id} ('{task['name']}')",
        f"Traversed (blocked:Task)-[:DEPENDS_ON*1..6]->(target:Task {{id: {task_id}}})",
        f"Found {len(blocked)} distinct blocked downstream tasks",
    ]
    for b in blocked:
        evidence.append(f"Blocked Task {b['id']} ('{b['name']}') at depth {b['depth']} via path: {' -> '.join(b['pathNames'])}")

    return {
        "taskId": task_id,
        "taskName": task["name"],
        "blockedDownstream": blocked,
        "count": len(blocked),
        "evidence": evidence,
    }


def rank_overdue_by_impact(graph=None) -> Dict[str, Any]:
    """
    Tool 4: rank_overdue_by_impact()
    Ranks all overdue tasks by counting downstream blocked tasks.
    Tie-breaking: (-blocksCount, -daysOverdue, taskId).
    """
    g = graph or get_graph()
    today_utc = _get_today_utc()
    ranked = graph_rank_overdue_by_impact(g, today_utc)
    evidence = [
        f"Impact ranking calculated relative to UTC {today_utc}",
        "Ranking criteria: blocksCount DESC, daysOverdue DESC, taskId ASC",
    ]
    for idx, r in enumerate(ranked, start=1):
        evidence.append(
            f"#{idx}: Task {r['taskId']} ('{r['name']}') blocks {r['blocksCount']} tasks, {r['daysOverdue']}d overdue (Owner: {r['owner']})"
        )

    return {
        "todayUtc": today_utc,
        "rankedTasks": ranked,
        "count": len(ranked),
        "evidence": evidence,
    }


def get_task_owner(task_id: int, graph=None) -> Dict[str, Any]:
    """
    Tool 5: get_task_owner(task_id)
    Returns task owner and manager escalation chain via REPORTS_TO*1..3.
    """
    if not isinstance(task_id, int) or task_id <= 0:
        return {"error": "Invalid task_id: must be a positive integer"}

    g = graph or get_graph()
    task = get_task_by_id(g, task_id)
    if not task:
        return {"error": f"Task {task_id} not found in graph"}

    owner_info = get_task_owner_and_escalation(g, task_id)
    if not owner_info:
        return {"error": f"Owner not found for task {task_id}"}

    evidence = [
        f"Task {task_id} ('{task['name']}') owned by (Person {{name: '{owner_info['owner']}'}})",
        f"Escalation chain via [:REPORTS_TO*1..3]: {' -> '.join(owner_info['escalationChain'])}",
    ]
    if owner_info.get("manager"):
        evidence.append(f"Direct manager identified as {owner_info['manager']}")

    return {
        "taskId": task_id,
        "taskName": task["name"],
        "owner": owner_info["owner"],
        "email": owner_info["email"],
        "manager": owner_info.get("manager"),
        "escalationChain": owner_info["escalationChain"],
        "evidence": evidence,
    }


def find_helpers(task_id: int, graph=None) -> Dict[str, Any]:
    """
    Tool 6: find_helpers(task_id)
    Finds colleagues who worked on the same project who might unblock the task.
    """
    if not isinstance(task_id, int) or task_id <= 0:
        return {"error": "Invalid task_id: must be a positive integer"}

    g = graph or get_graph()
    task = get_task_by_id(g, task_id)
    if not task:
        return {"error": f"Task {task_id} not found in graph"}

    helpers = graph_find_helpers(g, task_id)
    evidence = [
        f"Task {task_id} ('{task['name']}') belongs to Project '{task['project']}'",
        f"Traversed (t)-[:IN_PROJECT]->(pr)<-[:WORKED_ON]-(h:Person) excluding current owner '{task['owner']}'",
        f"Found {len(helpers)} candidate helpers",
    ]
    for h in helpers:
        evidence.append(f"Helper: {h['name']} ({h['email']}) on Project '{h['project']}'")

    return {
        "taskId": task_id,
        "taskName": task["name"],
        "project": task["project"],
        "owner": task["owner"],
        "helpers": helpers,
        "count": len(helpers),
        "evidence": evidence,
    }


def draft_reminder(task_id: int, graph=None) -> Dict[str, Any]:
    """
    Tool 7: draft_reminder(task_id) (READ-ONLY)
    Synthesizes a polite, context-aware reminder referencing:
    - Downstream blocked tasks (count & names)
    - Days overdue
    - Candidate helpers on the project
    - CCs the owner's manager from the escalation chain
    Includes explicit warning that human approval is required.
    """
    if not isinstance(task_id, int) or task_id <= 0:
        return {"error": "Invalid task_id: must be a positive integer"}

    g = graph or get_graph()
    task = get_task_by_id(g, task_id)
    if not task:
        return {"error": f"Task {task_id} not found in graph"}

    # Gather graph context
    today_utc = _get_today_utc()
    try:
        today_dt = datetime.strptime(today_utc, "%Y-%m-%d").date()
        deadline_dt = datetime.strptime(task["deadline"], "%Y-%m-%d").date()
        days_overdue = max(0, (today_dt - deadline_dt).days)
    except Exception:
        days_overdue = 0

    blocked = graph_get_blocked_downstream(g, task_id)
    owner_info = get_task_owner_and_escalation(g, task_id) or {
        "owner": task["owner"],
        "email": task["email"],
        "manager": None,
        "escalationChain": [task["owner"]],
    }
    helpers = graph_find_helpers(g, task_id)

    # Build draft text
    recipient = f"{owner_info['owner']} <{owner_info['email']}>"
    manager_cc = owner_info.get("manager")
    cc_line = f"CC: {manager_cc}" if manager_cc else "CC: None"

    blocked_count = len(blocked)
    if blocked_count > 0:
        blocked_names = ", ".join(f"'{b['name']}'" for b in blocked[:3])
        if blocked_count > 3:
            blocked_names += f" and {blocked_count - 3} more"
        impact_statement = f"This task is currently blocking {blocked_count} downstream task(s): {blocked_names}."
    else:
        impact_statement = "This task has no direct downstream dependencies recorded, but completing it keeps the project on schedule."

    if helpers:
        helper_names = ", ".join(h["name"] for h in helpers[:2])
        helper_statement = f"Colleagues {helper_names} have worked on {task['project']} and may be able to assist if needed."
    else:
        helper_statement = "Please reach out to the project team if any blockers arise."

    message = (
        f"Hi {owner_info['owner']},\n\n"
        f"Friendly reminder regarding '{task['name']}' (Project: {task['project']}), which was due on {task['deadline']} "
        f"({days_overdue} day(s) overdue).\n\n"
        f"{impact_statement}\n\n"
        f"{helper_statement}\n\n"
        f"Please update the task status once progress is made.\n\n"
        f"Best regards,\nTaskPilot Agent"
    )

    evidence = [
        f"Drafted reminder for Task {task_id} ('{task['name']}')",
        f"Owner: {owner_info['owner']} ({owner_info['email']})",
        f"Manager CC: {manager_cc} (via escalation chain)",
        f"Injected {blocked_count} blocked downstream tasks into reminder text",
        f"Injected {len(helpers)} helper options into reminder text",
    ]

    return {
        "taskId": task_id,
        "taskName": task["name"],
        "recipient": recipient,
        "owner": owner_info["owner"],
        "email": owner_info["email"],
        "managerCc": manager_cc,
        "daysOverdue": days_overdue,
        "blockedCount": blocked_count,
        "draftMessage": message,
        "humanApprovalRequired": True,
        "approvalNote": "HUMAN APPROVAL REQUIRED before sending. Use POST /api/approve with action ID.",
        "evidence": evidence,
    }


def update_task_status(task_id: int, status: str, graph=None) -> Dict[str, Any]:
    """
    Tool 8: update_task_status(task_id, status) (WRITE TOOL - MCP ONLY)
    Updates task status in FalkorDB.
    Returns status update confirmation and downstream unblock warning.
    """
    if not isinstance(task_id, int) or task_id <= 0:
        return {"error": "Invalid task_id: must be a positive integer"}

    if not isinstance(status, str) or not status.strip() or len(status.strip()) > 50:
        return {"error": "Invalid status: must be a non-empty string with max 50 characters"}

    g = graph or get_graph()
    clean_status = status.strip()
    result = graph_update_task_status(g, task_id, clean_status)
    if not result:
        return {"error": f"Task {task_id} not found in graph"}

    evidence = [
        f"Updated Task {task_id} ('{result['name']}') status to '{clean_status}' in FalkorDB",
    ]
    warning = "Status updated."
    if clean_status.lower() == "done":
        warning += " If marked Done, downstream tasks may now be unblocked."
        evidence.append("Downstream dependencies may now proceed")

    return {
        "taskId": task_id,
        "name": result["name"],
        "newStatus": clean_status,
        "warning": warning,
        "evidence": evidence,
    }


def get_pagerank_criticality(graph=None) -> Dict[str, Any]:
    """
    Optional Tool 9: get_pagerank_criticality()
    Calculates PageRank score across the Task DEPENDS_ON topology.
    """
    g = graph or get_graph()
    scores = page_rank_criticality(g)
    return {
        "criticalityScores": scores,
        "count": len(scores),
        "evidence": ["Calculated native FalkorDB PageRank on (:Task)-[:DEPENDS_ON]->(:Task)"],
    }
