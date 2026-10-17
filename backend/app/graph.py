"""
FalkorDB Graph Module for TaskPilot Graph.
Manages FalkorDB connection and encapsulates all Cypher queries with documentation.
Every piece of task, person, project, dependency, and approval state lives strictly in FalkorDB.
"""

import os
from typing import Any, Dict, List, Optional
from datetime import datetime
from falkordb import FalkorDB

# Configuration from environment variables
FALKORDB_HOST = os.getenv("FALKORDB_HOST", "localhost")
FALKORDB_PORT = int(os.getenv("FALKORDB_PORT", "6379"))
FALKORDB_USERNAME = os.getenv("FALKORDB_USERNAME") or None
FALKORDB_PASSWORD = os.getenv("FALKORDB_PASSWORD") or None
FALKORDB_GRAPH = os.getenv("FALKORDB_GRAPH", "taskpilot")

_client: Optional[FalkorDB] = None


def get_client() -> FalkorDB:
    """Returns singleton FalkorDB client connection."""
    global _client
    if _client is None:
        _client = FalkorDB(
            host=FALKORDB_HOST,
            port=FALKORDB_PORT,
            username=FALKORDB_USERNAME,
            password=FALKORDB_PASSWORD,
        )
    return _client


def get_graph(graph_name: Optional[str] = None):
    """Returns a FalkorDB Graph object for executing Cypher queries."""
    client = get_client()
    return client.select_graph(graph_name or FALKORDB_GRAPH)


def init_schema_and_indexes(graph) -> None:
    """
    Creates openCypher range indexes for fast node lookups:
    - Task.id: Fast lookups for task details and dependency resolution.
    - Person.name: Fast lookups for task owners and escalation paths.
    - Action.id: Fast lookups for atomic human approval commits.
    """
    indexes = [
        "CREATE INDEX FOR (t:Task) ON (t.id)",
        "CREATE INDEX FOR (p:Person) ON (p.name)",
        "CREATE INDEX FOR (a:Action) ON (a.id)",
    ]
    for idx_cypher in indexes:
        try:
            graph.query(idx_cypher)
        except Exception:
            # Index may already exist
            pass


def get_all_tasks(graph) -> List[Dict[str, Any]]:
    """
    Cypher: Retrieves all tasks with their respective owner and project.
    Used by: GET /api/tasks and MCP get_tasks().
    Query joins Task to Project via IN_PROJECT, and Person to Task via OWNS.
    """
    cypher = """
    MATCH (t:Task)
    OPTIONAL MATCH (p:Person)-[:OWNS]->(t)
    OPTIONAL MATCH (t)-[:IN_PROJECT]->(pr:Project)
    RETURN t.id AS id, t.name AS name, t.deadline AS deadline, t.status AS status,
           t.reminderSent AS reminderSent, t.reminderSentAt AS reminderSentAt,
           p.name AS owner, p.email AS email, pr.name AS project
    ORDER BY t.id ASC
    """
    res = graph.query(cypher)
    tasks = []
    for row in res.result_set:
        tasks.append({
            "id": row[0],
            "name": row[1],
            "deadline": row[2],
            "status": row[3],
            "reminderSent": bool(row[4]) if row[4] is not None else False,
            "reminderSentAt": row[5],
            "owner": row[6] or "Unassigned",
            "email": row[7] or "",
            "project": row[8] or "",
        })
    return tasks


def get_task_by_id(graph, task_id: int) -> Optional[Dict[str, Any]]:
    """
    Cypher: Retrieves a single task by ID with its owner and project.
    Used by: draft_reminder, update_task_status, get_task_owner.
    """
    cypher = """
    MATCH (t:Task {id: $task_id})
    OPTIONAL MATCH (p:Person)-[:OWNS]->(t)
    OPTIONAL MATCH (t)-[:IN_PROJECT]->(pr:Project)
    RETURN t.id AS id, t.name AS name, t.deadline AS deadline, t.status AS status,
           t.reminderSent AS reminderSent, t.reminderSentAt AS reminderSentAt,
           p.name AS owner, p.email AS email, pr.name AS project
    """
    res = graph.query(cypher, {"task_id": task_id})
    if not res.result_set:
        return None
    row = res.result_set[0]
    return {
        "id": row[0],
        "name": row[1],
        "deadline": row[2],
        "status": row[3],
        "reminderSent": bool(row[4]) if row[4] is not None else False,
        "reminderSentAt": row[5],
        "owner": row[6] or "Unassigned",
        "email": row[7] or "",
        "project": row[8] or "",
    }


def find_overdue_tasks(graph, today_utc: str) -> List[Dict[str, Any]]:
    """
    Cypher: Finds overdue tasks where deadline < today UTC and status != 'Done'.
    Used by: find_overdue_tasks tool and agent loop.
    Computes days overdue in Python based on the UTC deadline.
    """
    cypher = """
    MATCH (p:Person)-[:OWNS]->(t:Task)-[:IN_PROJECT]->(pr:Project)
    WHERE t.deadline < $today_utc AND toLower(trim(t.status)) <> 'done'
    RETURN t.id AS id, t.name AS name, t.deadline AS deadline, t.status AS status,
           t.reminderSent AS reminderSent, t.reminderSentAt AS reminderSentAt,
           p.name AS owner, p.email AS email, pr.name AS project
    ORDER BY t.deadline ASC, t.id ASC
    """
    res = graph.query(cypher, {"today_utc": today_utc})
    tasks = []
    today_dt = datetime.strptime(today_utc, "%Y-%m-%d").date()

    for row in res.result_set:
        deadline_str = row[2]
        try:
            deadline_dt = datetime.strptime(deadline_str, "%Y-%m-%d").date()
            days_overdue = (today_dt - deadline_dt).days
        except Exception:
            days_overdue = 0

        tasks.append({
            "id": row[0],
            "name": row[1],
            "deadline": row[2],
            "status": row[3],
            "reminderSent": bool(row[4]) if row[4] is not None else False,
            "reminderSentAt": row[5],
            "owner": row[6] or "Unassigned",
            "email": row[7] or "",
            "project": row[8] or "",
            "daysOverdue": max(0, days_overdue),
        })
    return tasks


def get_blocked_downstream(graph, task_id: int) -> List[Dict[str, Any]]:
    """
    Cypher: Traverses multi-hop dependency paths to find all downstream tasks blocked by task_id.
    Relationship direction: (A)-[:DEPENDS_ON]->(B) means 'A depends on B / A is blocked by B'.
    So path is: (blocked:Task)-[:DEPENDS_ON*1..6]->(target:Task {id: $task_id}).
    Used by: get_blocked_downstream tool and impact ranking.
    """
    cypher = """
    MATCH path = (blocked:Task)-[:DEPENDS_ON*1..6]->(target:Task {id: $task_id})
    OPTIONAL MATCH (p:Person)-[:OWNS]->(blocked)
    RETURN blocked.id AS id, blocked.name AS name, blocked.status AS status,
           blocked.deadline AS deadline, p.name AS owner,
           length(path) AS depth,
           [n IN nodes(path) | n.name] AS path_names
    ORDER BY depth ASC, blocked.id ASC
    """
    res = graph.query(cypher, {"task_id": task_id})
    results = []
    for row in res.result_set:
        results.append({
            "id": row[0],
            "name": row[1],
            "status": row[2],
            "deadline": row[3],
            "owner": row[4] or "Unassigned",
            "depth": row[5],
            "pathNames": row[6] or [],
        })
    return results


def rank_overdue_by_impact(graph, today_utc: str) -> List[Dict[str, Any]]:
    """
    Cypher: Finds overdue tasks and counts distinct downstream tasks blocked by each.
    Used by: rank_overdue_by_impact tool and deterministic agent.
    Tie-break rules:
      1. blocksCount DESC (most downstream impact first)
      2. daysOverdue DESC (more days overdue first)
      3. id ASC (lower task ID first)
    """
    cypher = """
    MATCH (p:Person)-[:OWNS]->(t:Task)-[:IN_PROJECT]->(pr:Project)
    WHERE t.deadline < $today_utc AND toLower(trim(t.status)) <> 'done'
    OPTIONAL MATCH (blocked:Task)-[:DEPENDS_ON*1..6]->(t)
    WITH t, p, pr, count(DISTINCT blocked) AS blocks_count
    RETURN t.id AS id, t.name AS name, t.deadline AS deadline, t.status AS status,
           t.reminderSent AS reminderSent, p.name AS owner, p.email AS email,
           pr.name AS project, blocks_count
    """
    res = graph.query(cypher, {"today_utc": today_utc})
    today_dt = datetime.strptime(today_utc, "%Y-%m-%d").date()

    ranked = []
    for row in res.result_set:
        deadline_str = row[2]
        try:
            deadline_dt = datetime.strptime(deadline_str, "%Y-%m-%d").date()
            days_overdue = (today_dt - deadline_dt).days
        except Exception:
            days_overdue = 0

        ranked.append({
            "taskId": row[0],
            "name": row[1],
            "deadline": row[2],
            "status": row[3],
            "reminderSent": bool(row[4]) if row[4] is not None else False,
            "owner": row[5],
            "email": row[6],
            "project": row[7],
            "blocksCount": int(row[8]),
            "daysOverdue": max(0, days_overdue),
        })

    # Sort: -blocksCount, -daysOverdue, taskId
    ranked.sort(key=lambda x: (-x["blocksCount"], -x["daysOverdue"], x["taskId"]))
    return ranked


def get_task_owner_and_escalation(graph, task_id: int) -> Optional[Dict[str, Any]]:
    """
    Cypher: Finds task owner and traverses the management chain via REPORTS_TO*1..3.
    Used by: get_task_owner tool and draft_reminder (for manager CC).
    """
    cypher = """
    MATCH (p:Person)-[:OWNS]->(t:Task {id: $task_id})
    OPTIONAL MATCH path = (p)-[:REPORTS_TO*1..3]->(m:Person)
    RETURN p.name AS owner, p.email AS email,
           [n IN nodes(path) | n.name] AS chain
    """
    res = graph.query(cypher, {"task_id": task_id})
    if not res.result_set:
        return None

    owner = res.result_set[0][0]
    email = res.result_set[0][1]

    # Find longest escalation chain from returned paths
    longest_chain = [owner]
    for row in res.result_set:
        chain = row[2]
        if chain and len(chain) > len(longest_chain):
            longest_chain = chain

    manager = longest_chain[1] if len(longest_chain) > 1 else None
    return {
        "owner": owner,
        "email": email,
        "manager": manager,
        "escalationChain": longest_chain,
    }


def find_helpers(graph, task_id: int) -> List[Dict[str, Any]]:
    """
    Cypher: Finds colleagues who WORKED_ON the task's project but do not own this specific task.
    Used by: find_helpers tool.
    """
    cypher = """
    MATCH (t:Task {id: $task_id})-[:IN_PROJECT]->(pr:Project)<-[:WORKED_ON]-(h:Person)
    WHERE NOT (h)-[:OWNS]->(t)
    RETURN DISTINCT h.name AS name, h.email AS email, pr.name AS project
    ORDER BY h.name ASC
    """
    res = graph.query(cypher, {"task_id": task_id})
    helpers = []
    for row in res.result_set:
        helpers.append({
            "name": row[0],
            "email": row[1],
            "project": row[2],
        })
    return helpers


def update_task_status(graph, task_id: int, status: str) -> Optional[Dict[str, Any]]:
    """
    Cypher: Updates a task status in the graph.
    Used by: update_task_status tool (MCP only).
    """
    cypher = """
    MATCH (t:Task {id: $task_id})
    SET t.status = $status
    RETURN t.id AS id, t.name AS name, t.status AS status, t.reminderSent AS reminderSent
    """
    res = graph.query(cypher, {"task_id": task_id, "status": status})
    if not res.result_set:
        return None
    row = res.result_set[0]
    return {
        "id": row[0],
        "name": row[1],
        "status": row[2],
        "reminderSent": bool(row[3]) if row[3] is not None else False,
    }


def save_pending_action(
    graph,
    action_id: str,
    task_id: int,
    owner: str,
    email: str,
    task_name: str,
    message: str,
    created_at_iso: str,
) -> None:
    """
    Cypher: Stores an Action node in the graph linked to the Task via FOR relationship.
    State starts as 'pending'.
    Used by: agent loop after drafting reminders.
    """
    cypher = """
    MATCH (t:Task {id: $task_id})
    MERGE (a:Action {id: $action_id})
    SET a.state = 'pending',
        a.owner = $owner,
        a.email = $email,
        a.taskName = $task_name,
        a.message = $message,
        a.createdAt = $created_at
    MERGE (a)-[:FOR]->(t)
    """
    graph.query(
        cypher,
        {
            "task_id": task_id,
            "action_id": action_id,
            "owner": owner,
            "email": email,
            "task_name": task_name,
            "message": message,
            "created_at": created_at_iso,
        },
    )


def approve_action(graph, action_id: str, now_iso: str) -> Dict[str, Any]:
    """
    Cypher: Looks up Action node by ID, verifies 60-minute expiry and state,
    and atomically updates Task.reminderSent = true and Action.state = 'approved'.
    Client-supplied fields are strictly ignored.
    Used by: POST /api/approve.
    """
    cypher_check = """
    MATCH (a:Action {id: $action_id})-[:FOR]->(t:Task)
    OPTIONAL MATCH (p:Person)-[:OWNS]->(t)
    RETURN a.id AS id, a.state AS state, a.createdAt AS createdAt,
           t.id AS taskId, t.name AS taskName, t.reminderSent AS reminderSent,
           p.name AS owner
    """
    res = graph.query(cypher_check, {"action_id": action_id})
    if not res.result_set:
        return {"id": action_id, "result": "failed", "detail": "Unknown or expired action"}

    row = res.result_set[0]
    state = row[1]
    created_at_str = row[2]
    task_id = row[3]
    reminder_sent = bool(row[5]) if row[5] is not None else False
    owner = row[6] or "Owner"

    # Verify 60-minute TTL expiry
    try:
        created_dt = datetime.fromisoformat(created_at_str)
        now_dt = datetime.fromisoformat(now_iso)
        if (now_dt - created_dt).total_seconds() > 3600:
            return {"id": action_id, "result": "failed", "detail": "Unknown or expired action"}
    except Exception:
        return {"id": action_id, "result": "failed", "detail": "Invalid action timestamp"}

    # Check for duplicate approvals
    if state == "approved" or reminder_sent:
        return {"id": action_id, "result": "skipped", "detail": "Reminder already recorded"}

    cypher_commit = """
    MATCH (a:Action {id: $action_id})-[:FOR]->(t:Task)
    SET t.reminderSent = true,
        t.reminderSentAt = $now_iso,
        a.state = 'approved'
    RETURN t.id AS taskId
    """
    graph.query(cypher_commit, {"action_id": action_id, "now_iso": now_iso})

    return {
        "id": action_id,
        "result": "done",
        "detail": f"Reminder to {owner} recorded (simulated send)",
    }


def get_graph_visualization(graph) -> Dict[str, Any]:
    """
    Cypher: Extracts all nodes and edges for visual dashboard representation.
    Used by: GET /api/graph.
    """
    cypher_nodes = "MATCH (n) RETURN id(n) AS internal_id, labels(n)[0] AS label, properties(n) AS props"
    cypher_edges = """
    MATCH (s)-[r]->(t)
    RETURN id(s) AS source, id(t) AS target, type(r) AS type, properties(r) AS props
    """
    nodes_res = graph.query(cypher_nodes)
    edges_res = graph.query(cypher_edges)

    nodes = []
    for r in nodes_res.result_set:
        nodes.append({"id": str(r[0]), "label": r[1], "properties": r[2]})

    edges = []
    for r in edges_res.result_set:
        edges.append({"source": str(r[0]), "target": str(r[1]), "type": r[2], "properties": r[3]})

    return {"nodes": nodes, "edges": edges}


def page_rank_criticality(graph) -> List[Dict[str, Any]]:
    """
    Cypher: Runs native FalkorDB PageRank algorithm on Task dependency topology.
    Used by: Optional PageRank criticality tool.
    """
    cypher = """
    CALL algo.pageRank('Task', 'DEPENDS_ON')
    YIELD node, score
    RETURN node.id AS id, node.name AS name, score
    ORDER BY score DESC
    """
    try:
        res = graph.query(cypher)
        criticality = []
        for row in res.result_set:
            criticality.append({"taskId": row[0], "name": row[1], "score": float(row[2])})
        return criticality
    except Exception:
        return []


def clear_graph(graph) -> None:
    """Cypher: Deletes all nodes and relationships."""
    graph.query("MATCH (n) DETACH DELETE n")
