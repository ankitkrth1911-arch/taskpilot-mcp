"""
Unit tests for input validation on all tools in app.tools.
Ensures invalid task_ids, malformed statuses, and boundary conditions are handled cleanly.
"""

from app.tools import (
    get_blocked_downstream,
    get_task_owner,
    find_helpers,
    draft_reminder,
    update_task_status,
)


def test_invalid_task_id_types():
    """Verify non-integer or non-positive task IDs return validation error dict."""
    for invalid_id in [-1, 0, "1", None, 3.14]:
        res = get_blocked_downstream(invalid_id)
        assert "error" in res
        assert "positive integer" in res["error"].lower()

        res_owner = get_task_owner(invalid_id)
        assert "error" in res_owner
        assert "positive integer" in res_owner["error"].lower()

        res_helpers = find_helpers(invalid_id)
        assert "error" in res_helpers
        assert "positive integer" in res_helpers["error"].lower()

        res_draft = draft_reminder(invalid_id)
        assert "error" in res_draft
        assert "positive integer" in res_draft["error"].lower()


def test_update_task_status_validation():
    """Verify status string boundaries (empty, overly long, invalid task ID)."""
    # Invalid task ID
    res1 = update_task_status(0, "Done")
    assert "error" in res1

    # Empty status
    res2 = update_task_status(1, "")
    assert "error" in res2
    assert "non-empty" in res2["error"].lower()

    # Whitespace only
    res3 = update_task_status(1, "   ")
    assert "error" in res3

    # Exceeding 50 characters
    long_status = "A" * 51
    res4 = update_task_status(1, long_status)
    assert "error" in res4
    assert "50 characters" in res4["error"].lower()
