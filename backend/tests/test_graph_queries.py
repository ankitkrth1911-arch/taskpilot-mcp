"""
Unit tests for graph query logic, ranking algorithm, escalation chain, and approval verification.
Uses a mock graph interface to test business logic and edge cases in isolation.
"""

from unittest.mock import MagicMock
from datetime import datetime, timezone, timedelta
from app.graph import (
    find_overdue_tasks,
    get_blocked_downstream,
    rank_overdue_by_impact,
    get_task_owner_and_escalation,
    find_helpers,
    approve_action,
)


def test_ranking_tiebreak_order():
    """
    Verifies that rank_overdue_by_impact strictly respects:
    1. blocksCount DESC
    2. daysOverdue DESC
    3. taskId ASC
    """
    mock_graph = MagicMock()
    # Mocking rows returned: [id, name, deadline, status, reminderSent, owner, email, project, blocks_count]
    # Today is 2026-10-17
    mock_graph.query.return_value.result_set = [
        [1, "Doc", "2026-10-16", "Pending", False, "Rahul", "r@demo.com", "Website", 1],   # blocks 1, 1 day overdue
        [3, "Backend", "2026-10-15", "Pending", False, "Aman", "a@demo.com", "Website", 2],# blocks 2, 2 days overdue
        [7, "Onboarding", "2026-10-16", "Pending", False, "Priya", "p@demo.com", "Mobile", 1], # blocks 1, 1 day overdue
    ]

    ranked = rank_overdue_by_impact(mock_graph, "2026-10-17")
    ids = [r["taskId"] for r in ranked]
    # Task 3 has blocksCount 2 -> 1st
    # Task 1 and 7 both have blocksCount 1, 1 day overdue -> Task 1 wins tiebreak by taskId (1 < 7)
    assert ids == [3, 1, 7], f"Expected [3, 1, 7] but got {ids}"
    assert ranked[0]["blocksCount"] == 2
    assert ranked[1]["blocksCount"] == 1
    assert ranked[2]["blocksCount"] == 1


def test_escalation_chain_selection():
    """Verifies that the longest REPORTS_TO chain is chosen and manager is chain[1]."""
    mock_graph = MagicMock()
    # Two paths returned: Rahul -> Neha, Rahul -> Neha -> Karan
    mock_graph.query.return_value.result_set = [
        ["Rahul", "rahul@demo.com", ["Rahul", "Neha"]],
        ["Rahul", "rahul@demo.com", ["Rahul", "Neha", "Karan"]],
    ]

    res = get_task_owner_and_escalation(mock_graph, 1)
    assert res is not None
    assert res["owner"] == "Rahul"
    assert res["manager"] == "Neha"
    assert res["escalationChain"] == ["Rahul", "Neha", "Karan"]


def test_approve_action_ttl_expiry():
    """Verifies that Action nodes older than 60 minutes are rejected as expired."""
    mock_graph = MagicMock()
    now_utc = datetime.now(timezone.utc)
    expired_created_at = (now_utc - timedelta(minutes=61)).isoformat()
    now_iso = now_utc.isoformat()

    # [id, state, createdAt, taskId, taskName, reminderSent, owner]
    mock_graph.query.return_value.result_set = [
        ["act_123", "pending", expired_created_at, 1, "Task 1", False, "Rahul"]
    ]

    outcome = approve_action(mock_graph, "act_123", now_iso)
    assert outcome["result"] == "failed"
    assert "expired" in outcome["detail"].lower()


def test_approve_action_already_recorded():
    """Verifies that already approved actions return result: 'skipped'."""
    mock_graph = MagicMock()
    now_utc = datetime.now(timezone.utc)
    recent_created_at = (now_utc - timedelta(minutes=5)).isoformat()
    now_iso = now_utc.isoformat()

    mock_graph.query.return_value.result_set = [
        ["act_123", "approved", recent_created_at, 1, "Task 1", True, "Rahul"]
    ]

    outcome = approve_action(mock_graph, "act_123", now_iso)
    assert outcome["result"] == "skipped"
    assert "already recorded" in outcome["detail"].lower()


def test_approve_action_successful_commit():
    """Verifies that valid pending actions commit successfully."""
    mock_graph = MagicMock()
    now_utc = datetime.now(timezone.utc)
    recent_created_at = (now_utc - timedelta(minutes=5)).isoformat()
    now_iso = now_utc.isoformat()

    mock_graph.query.return_value.result_set = [
        ["act_123", "pending", recent_created_at, 1, "Complete doc", False, "Rahul"]
    ]

    outcome = approve_action(mock_graph, "act_123", now_iso)
    assert outcome["result"] == "done"
    assert "Rahul" in outcome["detail"]
    assert mock_graph.query.call_count >= 2  # Query check + commit
