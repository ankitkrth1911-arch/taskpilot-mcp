"""
Human Approval Module for TaskPilot Graph.
Handles atomic human approval of drafted reminder actions.
Strictly relies on Action nodes persisted in FalkorDB, ignoring any
client-supplied messages or task data to prevent forgery.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from app.graph import get_graph, approve_action as graph_approve_action


def process_approvals(payload: Dict[str, Any], graph=None) -> Dict[str, Any]:
    """
    Processes human approvals from flexible payload formats:
    - { "actions": [ {"id": "act_..."}, ... ] }
    - { "actions": [ {"actionId": "act_..."}, ... ] }
    - { "actionIds": ["act_...", ...] }

    Returns:
    - Dict with "results": list of outcome dicts
    Raises:
    - ValueError if payload is malformed or contains no action IDs
    """
    g = graph or get_graph()
    action_ids: List[str] = []

    if not isinstance(payload, dict):
        raise ValueError("Invalid request body: expected JSON object")

    if "actionIds" in payload and isinstance(payload["actionIds"], list):
        for item in payload["actionIds"]:
            if isinstance(item, str) and item.strip():
                action_ids.append(item.strip())
    elif "actions" in payload and isinstance(payload["actions"], list):
        for item in payload["actions"]:
            if isinstance(item, dict):
                act_id = item.get("id") or item.get("actionId")
                if isinstance(act_id, str) and act_id.strip():
                    action_ids.append(act_id.strip())
            elif isinstance(item, str) and item.strip():
                action_ids.append(item.strip())

    if not action_ids:
        raise ValueError("No valid action IDs provided in request")

    now_iso = datetime.now(timezone.utc).isoformat()
    results = []
    for act_id in action_ids:
        res = graph_approve_action(g, act_id, now_iso)
        results.append(res)

    return {"results": results}
