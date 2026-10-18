"""
Unit tests for Billing, Plans, and Quotas.
Tests:
- Removed payment routes (POST /api/billing/checkout, /verify, /webhook) return 404
- GET /api/billing/me returns plan id, limits, and usage
- Quota exhaustion on workspace agent execution (429)
- Free plan blocked from GitHub import (403)
- Pro plan allowed GitHub import (200)
- Max tasks per workspace plan quota enforcement (403)
"""

import os
import time
import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
from app.main import app
import app.auth as auth_module
import app.billing as billing_module
import jwt

TEST_JWT_SECRET = "test-secret-key-that-is-at-least-32-bytes-long"
TEST_SUPABASE_URL = "https://test.supabase.co"

def make_test_jwt(sub: str, email: str = "user@test.com", is_anonymous: bool = False, exp_offset: int = 3600) -> str:
    now = int(time.time())
    payload = {
        "sub": sub,
        "email": email,
        "is_anonymous": is_anonymous,
        "aud": "authenticated",
        "iss": f"{TEST_SUPABASE_URL}/auth/v1",
        "iat": now,
        "exp": now + exp_offset,
        "role": "authenticated",
    }
    return jwt.encode(payload, TEST_JWT_SECRET, algorithm="HS256", headers={"alg": "HS256", "typ": "JWT"})

client = TestClient(app)

USER_A = "11111111-1111-1111-1111-111111111111"
GUEST_USER = "33333333-3333-3333-3333-333333333333"

TOKEN_A = make_test_jwt(USER_A, email="usera@example.com")
TOKEN_GUEST = make_test_jwt(GUEST_USER, is_anonymous=True)


@pytest.fixture(autouse=True)
def set_test_secrets(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", TEST_SUPABASE_URL)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test_service_role_key")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", TEST_JWT_SECRET)
    monkeypatch.setattr(auth_module, "SUPABASE_URL", TEST_SUPABASE_URL)
    monkeypatch.setattr(auth_module, "SUPABASE_JWT_SECRET", TEST_JWT_SECRET)
    monkeypatch.setattr(billing_module, "SUPABASE_URL", TEST_SUPABASE_URL)
    monkeypatch.setattr(billing_module, "SUPABASE_SERVICE_ROLE_KEY", "test_service_role_key")


def test_removed_checkout_route_returns_404():
    """POST /api/billing/checkout was removed and must return 404."""
    resp = client.post(
        "/api/billing/checkout",
        headers={"Authorization": f"Bearer {TOKEN_A}"},
        json={"plan": "pro"},
    )
    assert resp.status_code == 404


def test_removed_verify_route_returns_404():
    """POST /api/billing/verify was removed and must return 404."""
    resp = client.post(
        "/api/billing/verify",
        headers={"Authorization": f"Bearer {TOKEN_A}"},
        json={
            "order_id": "order_test_123",
            "payment_id": "pay_test_123",
            "signature": "sig_test_123",
        },
    )
    assert resp.status_code == 404


def test_removed_webhook_route_returns_404():
    """POST /api/billing/webhook was removed and must return 404."""
    resp = client.post(
        "/api/billing/webhook",
        headers={"Content-Type": "application/json"},
        json={"event": "payment.captured"},
    )
    assert resp.status_code == 404


def test_billing_me_returns_plan_and_usage():
    """GET /api/billing/me returns plan id, limits, and usage."""
    with patch("app.main.get_user_plan_id", new_callable=AsyncMock) as mock_plan, \
         patch("app.main.get_usage_today", new_callable=AsyncMock) as mock_usage:
        mock_plan.return_value = "free"
        mock_usage.return_value = {"agent": 3, "ai": 1}

        resp = client.get("/api/billing/me", headers={"Authorization": f"Bearer {TOKEN_A}"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["plan"] == "free"
        assert data["planName"] == "Free"
        assert "limits" in data
        assert data["usage"]["agent"] == 3
        assert data["isGuest"] is False


def test_free_plan_blocked_from_github_import():
    """POST /api/github/import returns 403 on free plan without github_import_allowed."""
    with patch("app.main.get_user_plan_id", new_callable=AsyncMock) as mock_plan:
        mock_plan.return_value = "free"
        resp = client.post(
            "/api/github/import",
            headers={"Authorization": f"Bearer {TOKEN_A}"},
        )
        assert resp.status_code == 403
        assert "not available on your current plan" in resp.json()["detail"]


def test_pro_plan_allowed_github_import():
    """POST /api/github/import succeeds on pro plan."""
    with patch("app.main.get_user_plan_id", new_callable=AsyncMock) as mock_plan:
        mock_plan.return_value = "pro"
        resp = client.post(
            "/api/github/import",
            headers={"Authorization": f"Bearer {TOKEN_A}"},
        )
        assert resp.status_code == 200
        assert "authorized" in resp.json()["message"]


def test_quota_exhaustion_in_workspace_returns_429():
    """POST /api/agent in workspace returns 429 when consume_quota returns False."""
    ws_id = "55555555-5555-5555-5555-555555555555"

    with patch("app.main.resolve_target_graph", new_callable=AsyncMock) as mock_resolve, \
         patch("app.main.consume_quota", new_callable=AsyncMock) as mock_quota, \
         patch("app.main.get_user_plan_id", new_callable=AsyncMock) as mock_plan:

        mock_resolve.return_value = (None, {"graph_name": "ws_test_quota"})
        mock_plan.return_value = "free"
        mock_quota.return_value = False  # Quota exceeded!

        resp = client.post(
            "/api/agent",
            headers={
                "Authorization": f"Bearer {TOKEN_A}",
                "X-Workspace": ws_id,
            },
            json={"instruction": "Find overdue tasks"},
        )
        assert resp.status_code == 429
        assert "Daily limit reached" in resp.json()["detail"]


def test_max_tasks_per_workspace_enforced():
    """POST /api/tasks rejects task creation with 403 when workspace task count reaches plan limit."""
    ws_id = "66666666-6666-6666-6666-666666666666"

    with patch("app.main.resolve_target_graph", new_callable=AsyncMock) as mock_resolve, \
         patch("app.main.get_user_plan_id", new_callable=AsyncMock) as mock_plan, \
         patch("app.main.get_plan_details", new_callable=AsyncMock) as mock_details, \
         patch("app.main.get_all_tasks") as mock_tasks:

        mock_resolve.return_value = (None, {"graph_name": "ws_test_cap"})
        mock_plan.return_value = "free"
        mock_details.return_value = {
            "name": "Free",
            "max_tasks_per_workspace": 2,
        }
        # Already 2 tasks exist
        mock_tasks.return_value = [{"id": 1}, {"id": 2}]

        resp = client.post(
            "/api/tasks",
            headers={
                "Authorization": f"Bearer {TOKEN_A}",
                "X-Workspace": ws_id,
            },
            json={
                "name": "Third task",
                "owner": "Charlie",
                "project": "Core",
            },
        )
        assert resp.status_code == 403
        assert "Plan limit reached" in resp.json()["detail"]
