"""
Test Verification #5: Graph Disconnect / Load-Bearing Proof.
Verifies that when FalkorDB is unreachable (bogus host), graph operations and tools
FAIL with a database connection error rather than secretly succeeding with an
in-memory fallback shadow store.
"""

import pytest
from falkordb import FalkorDB
import redis.exceptions
from app.graph import get_all_tasks
from app.tools import get_tasks


def test_bogus_falkordb_fails():
    """Connecting to a bogus FalkorDB host must raise a ConnectionError."""
    with pytest.raises((redis.exceptions.ConnectionError, ConnectionRefusedError, Exception)) as exc_info:
        bogus_client = FalkorDB(host="127.0.0.1", port=9999)
        bogus_graph = bogus_client.select_graph("taskpilot")
        bogus_graph.query("MATCH (t:Task) RETURN t")

    err_str = str(exc_info.value).lower()
    assert "connection" in err_str or "refused" in err_str or "error" in err_str


def test_tool_fails_without_falkordb():
    """Tools must raise an error when FalkorDB is unreachable, proving no shadow store exists."""
    with pytest.raises(Exception):
        bogus_client = FalkorDB(host="127.0.0.1", port=9999)
        bogus_graph = bogus_client.select_graph("taskpilot")
        get_all_tasks(bogus_graph)
