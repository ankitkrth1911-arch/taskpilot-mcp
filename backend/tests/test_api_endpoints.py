"""
Unit tests for FastAPI REST API endpoints in app.main.
Tests root healthcheck, admin security, agent input validation, rate limiting, and approval handling.
"""

from fastapi.testclient import TestClient
from app.main import app, _ip_requests

client = TestClient(app)


def test_root_endpoint():
    """GET / returns service health and metadata."""
    resp = client.get("/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["service"] == "TaskPilot Graph"
    assert data["database"] == "FalkorDB"
    assert data["mcp"] == "/mcp"


def test_admin_reset_security():
    """POST /api/admin/reset requires valid X-Admin-Token header."""
    # Missing header -> 401
    resp_no_token = client.post("/api/admin/reset")
    assert resp_no_token.status_code == 401

    # Wrong header -> 401
    resp_bad_token = client.post("/api/admin/reset", headers={"X-Admin-Token": "wrong-token"})
    assert resp_bad_token.status_code == 401


def test_agent_instruction_length_validation():
    """POST /api/agent rejects instructions over 500 characters with 400."""
    long_instruction = "A" * 501
    resp = client.post("/api/agent", json={"instruction": long_instruction})
    assert resp.status_code == 400
    assert "maximum length" in resp.json()["error"]


from unittest.mock import patch, AsyncMock

def test_agent_rate_limiting():
    """POST /api/agent triggers HTTP 429 when rate limit (10/min) is exceeded."""
    test_ip = "testclient"
    _ip_requests[test_ip] = []

    # Mock get_graph and run_agent so the 10 requests execute instantly without waiting for redis retries
    with patch("app.main.get_graph"), patch("app.main.run_agent", new_callable=AsyncMock) as mock_agent:
        mock_agent.return_value = {"status": "ok"}
        for i in range(10):
            resp = client.post("/api/agent", json={"instruction": f"ping {i}"})
            assert resp.status_code == 200

    # 11th request MUST be 429 Too Many Requests
    resp_limit = client.post("/api/agent", json={"instruction": "exceed limit"})
    assert resp_limit.status_code == 429
    assert resp_limit.json()["error"] == "Rate limit exceeded"
    assert "retryAfterSeconds" in resp_limit.json()
    assert "Retry-After" in resp_limit.headers

    # Clean up test IP state
    _ip_requests[test_ip] = []


def test_approve_payload_validation():
    """POST /api/approve validates payload structure."""
    # Non-JSON -> 400
    resp1 = client.post("/api/approve", content="not json", headers={"Content-Type": "application/json"})
    assert resp1.status_code == 400

    # Missing actions array -> 400
    resp2 = client.post("/api/approve", json={"foo": "bar"})
    assert resp2.status_code == 400
    assert "must contain 'actions' or 'actionIds'" in resp2.json()["error"]

    # Empty actions array -> 400
    resp3 = client.post("/api/approve", json={"actions": []})
    assert resp3.status_code == 400


def test_admin_cleanup_security(monkeypatch):
    """POST /api/admin/cleanup requires valid X-Admin-Token header."""
    monkeypatch.setenv("ADMIN_TOKEN", "super-secret-cleanup-token")

    # Missing header -> 401
    resp_no_token = client.post("/api/admin/cleanup")
    assert resp_no_token.status_code == 401

    # Wrong header -> 401
    resp_bad_token = client.post("/api/admin/cleanup", headers={"X-Admin-Token": "wrong-token"})
    assert resp_bad_token.status_code == 401

    # Valid token -> 200
    resp_valid = client.post("/api/admin/cleanup", headers={"X-Admin-Token": "super-secret-cleanup-token"})
    assert resp_valid.status_code == 200
    assert resp_valid.json()["status"] == "ok"


def test_payload_too_large_rejection():
    """POST request with body exceeding 64KB is rejected with 413 Payload Too Large."""
    large_payload = {"data": "x" * 70000}
    resp = client.post("/api/approve", json=large_payload)
    assert resp.status_code == 413
    assert "Payload too large" in resp.json()["detail"]

