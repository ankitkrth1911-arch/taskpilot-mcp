"""
FastMCP Server for TaskPilot Graph.
Exposes all graph-backed tools over the Model Context Protocol (MCP).
Supports both Streamable HTTP (/mcp) and standard MCP transports.
"""

from typing import Any, Dict, List
try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    from mcp.server.mcpserver import MCPServer as FastMCP

from app.tools import (
    get_tasks as tool_get_tasks,
    find_overdue_tasks as tool_find_overdue_tasks,
    get_blocked_downstream as tool_get_blocked_downstream,
    rank_overdue_by_impact as tool_rank_overdue_by_impact,
    get_task_owner as tool_get_task_owner,
    find_helpers as tool_find_helpers,
    draft_reminder as tool_draft_reminder,
    update_task_status as tool_update_task_status,
    get_pagerank_criticality as tool_get_pagerank_criticality,
)

mcp = FastMCP("TaskPilot Graph")


@mcp.tool()
def get_tasks() -> Dict[str, Any]:
    """List all tasks in the project graph with their owners and project assignments."""
    return tool_get_tasks()


@mcp.tool()
def find_overdue_tasks() -> Dict[str, Any]:
    """Find all tasks whose deadline is before today (UTC) and whose status is not 'Done'."""
    return tool_find_overdue_tasks()


@mcp.tool()
def get_blocked_downstream(task_id: int) -> Dict[str, Any]:
    """
    Traverse multi-hop dependency paths to find all downstream tasks blocked by this task.
    Shows the dependency depth and path for each blocked task.
    """
    return tool_get_blocked_downstream(task_id)


@mcp.tool()
def rank_overdue_by_impact() -> Dict[str, Any]:
    """
    Rank all overdue tasks by the number of downstream tasks they block.
    Returns tasks sorted by downstream impact, then days overdue.
    """
    return tool_rank_overdue_by_impact()


@mcp.tool()
def get_task_owner(task_id: int) -> Dict[str, Any]:
    """
    Find who owns a task, their email, and their management escalation chain
    via REPORTS_TO relationships.
    """
    return tool_get_task_owner(task_id)


@mcp.tool()
def find_helpers(task_id: int) -> Dict[str, Any]:
    """
    Find colleagues who worked on the same project who might be able to help
    unblock this task, excluding the current owner.
    """
    return tool_find_helpers(task_id)


@mcp.tool()
def draft_reminder(task_id: int) -> Dict[str, Any]:
    """
    (READ-ONLY) Draft a reminder for an overdue task citing specific blocked downstream
    tasks, days overdue, helper suggestions, and CC'ing the owner's manager.
    HUMAN APPROVAL REQUIRED before sending.
    """
    return tool_draft_reminder(task_id)


@mcp.tool()
def update_task_status(task_id: int, status: str) -> Dict[str, Any]:
    """
    (WRITE TOOL) Update the status of a task in FalkorDB (e.g., 'Done', 'In progress', 'Blocked').
    If marked 'Done', downstream tasks may now be unblocked.
    """
    return tool_update_task_status(task_id, status)


@mcp.tool()
def get_pagerank_criticality() -> Dict[str, Any]:
    """
    (ADVANCED) Calculate PageRank criticality across the task dependency topology
    using FalkorDB's native matrix graph algorithms.
    """
    return tool_get_pagerank_criticality()
