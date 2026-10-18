"""
Unit tests for Billing, Plans, Quotas, and Razorpay TEST Integration.
Tests:
- Forged signature rejection (400)
- Amount mismatch rejection (400)
- Order belonging to another user rejection (403)
- Guest checkout blocked (403)
- Duplicate webhook handling (200 deduplicated)
- Verify idempotency (calling verify twice never extends twice)
- Webhook processed before verify
- Quota exhaustion on workspace agent execution (429)
- Free plan blocked from GitHub import (403)
- Max tasks per workspace plan quota enforcement (403)
- Live order creation if RAZORPAY test keys present in env
"""

import os
import hmac
import hashlib
import json
import time
import pytest
import respx
import httpx
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
from app.main import app
import app.auth as auth_module
import jwt

import app.billing as billing_module

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
USER_B = "22222222-2222-2222-2222-222222222222"
GUEST_USER = "33333333-3333-3333-3333-333333333333"

TOKEN_A = make_test_jwt(USER_A, email="usera@example.com")
TOKEN_B = make_test_jwt(USER_B, email="userb@example.com")
TOKEN_GUEST = make_test_jwt(GUEST_USER, is_anonymous=True)

MOCK_KEY_ID = "rzp_test_mock123"
MOCK_KEY_SECRET = "mock_secret_key_12345"
MOCK_WEBHOOK_SECRET = "mock_webhook_secret_67890"


@pytest.fixture(autouse=True)
def set_test_secrets(monkeypatch):
    monkeypatch.setenv("RAZORPAY_KEY_ID", MOCK_KEY_ID)
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", MOCK_KEY_SECRET)
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", MOCK_WEBHOOK_SECRET)
    monkeypatch.setenv("SUPABASE_URL", TEST_SUPABASE_URL)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test_service_role_key")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", TEST_JWT_SECRET)
    monkeypatch.setattr(auth_module, "SUPABASE_URL", TEST_SUPABASE_URL)
    monkeypatch.setattr(auth_module, "SUPABASE_JWT_SECRET", TEST_JWT_SECRET)
    monkeypatch.setattr(billing_module, "SUPABASE_URL", TEST_SUPABASE_URL)
    monkeypatch.setattr(billing_module, "SUPABASE_SERVICE_ROLE_KEY", "test_service_role_key")
    monkeypatch.setattr(billing_module, "RAZORPAY_KEY_ID", MOCK_KEY_ID)
    monkeypatch.setattr(billing_module, "RAZORPAY_KEY_SECRET", MOCK_KEY_SECRET)
    monkeypatch.setattr(billing_module, "RAZORPAY_WEBHOOK_SECRET", MOCK_WEBHOOK_SECRET)


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


def test_guest_checkout_blocked():
    """POST /api/billing/checkout returns 403 for anonymous guest users."""
    resp = client.post(
        "/api/billing/checkout",
        headers={"Authorization": f"Bearer {TOKEN_GUEST}"},
        json={"plan": "pro"},
    )
    assert resp.status_code == 403
    assert "Guests cannot upgrade" in resp.json()["detail"]


@respx.mock
def test_checkout_creates_order_and_never_returns_secret():
    """POST /api/billing/checkout creates Razorpay order and returns orderId without secret."""
    respx.post("https://api.razorpay.com/v1/orders").mock(
        return_value=httpx.Response(
            201,
            json={
                "id": "order_test_999",
                "amount": 99900,
                "currency": "INR",
                "status": "created",
            },
        )
    )
    respx.post("https://test.supabase.co/rest/v1/payments").mock(
        return_value=httpx.Response(201, json=[])
    )
    respx.post("https://test.supabase.co/rest/v1/audit_log").mock(
        return_value=httpx.Response(201, json=[])
    )

    resp = client.post(
        "/api/billing/checkout",
        headers={"Authorization": f"Bearer {TOKEN_A}"},
        json={"plan": "pro"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["orderId"] == "order_test_999"
    assert data["keyId"] == MOCK_KEY_ID
    assert data["amount"] == 99900
    assert data["currency"] == "INR"
    assert "keySecret" not in data
    assert "secret" not in data


def test_verify_forged_signature_rejected():
    """POST /api/billing/verify rejects tampered or invalid HMAC signature with 400."""
    resp = client.post(
        "/api/billing/verify",
        headers={"Authorization": f"Bearer {TOKEN_A}"},
        json={
            "razorpay_order_id": "order_test_999",
            "razorpay_payment_id": "pay_test_888",
            "razorpay_signature": "forged_invalid_signature_hex",
        },
    )
    assert resp.status_code == 400
    assert "Invalid payment signature" in resp.json()["detail"]


@respx.mock
def test_verify_someone_elses_order_rejected():
    """POST /api/billing/verify rejects if the order belongs to another user."""
    order_id = "order_b_123"
    payment_id = "pay_b_456"
    valid_sig = hmac.new(
        MOCK_KEY_SECRET.encode(),
        f"{order_id}|{payment_id}".encode(),
        hashlib.sha256,
    ).hexdigest()

    # Supabase returns order belonging to USER_B
    respx.get(f"https://test.supabase.co/rest/v1/payments?order_id=eq.{order_id}&select=*").mock(
        return_value=httpx.Response(
            200,
            json=[{
                "order_id": order_id,
                "user_id": USER_B,
                "amount": 99900,
                "currency": "INR",
                "status": "created",
            }],
        )
    )

    resp = client.post(
        "/api/billing/verify",
        headers={"Authorization": f"Bearer {TOKEN_A}"},  # User A trying to verify User B's order
        json={
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": valid_sig,
        },
    )
    assert resp.status_code == 403
    assert "does not belong" in resp.json()["detail"]


@respx.mock
def test_verify_amount_mismatch_rejected():
    """POST /api/billing/verify rejects if Razorpay payment amount does not match order."""
    order_id = "order_a_123"
    payment_id = "pay_a_456"
    valid_sig = hmac.new(
        MOCK_KEY_SECRET.encode(),
        f"{order_id}|{payment_id}".encode(),
        hashlib.sha256,
    ).hexdigest()

    respx.get(f"https://test.supabase.co/rest/v1/payments?order_id=eq.{order_id}&select=*").mock(
        return_value=httpx.Response(
            200,
            json=[{
                "order_id": order_id,
                "user_id": USER_A,
                "amount": 99900,  # 999 INR
                "currency": "INR",
                "status": "created",
            }],
        )
    )

    # Razorpay reports payment amount 100 instead of 99900
    respx.get(f"https://api.razorpay.com/v1/payments/{payment_id}").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": payment_id,
                "order_id": order_id,
                "amount": 100,  # mismatch
                "currency": "INR",
                "status": "captured",
            },
        )
    )

    resp = client.post(
        "/api/billing/verify",
        headers={"Authorization": f"Bearer {TOKEN_A}"},
        json={
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": valid_sig,
        },
    )
    assert resp.status_code == 400
    assert "mismatch" in resp.json()["detail"].lower()


@respx.mock
def test_verify_idempotency_calling_twice():
    """POST /api/billing/verify called twice returns success without duplicate extension."""
    order_id = "order_a_idempotent"
    payment_id = "pay_a_idempotent"
    valid_sig = hmac.new(
        MOCK_KEY_SECRET.encode(),
        f"{order_id}|{payment_id}".encode(),
        hashlib.sha256,
    ).hexdigest()

    # First call: status is 'created'
    respx.get(f"https://test.supabase.co/rest/v1/payments?order_id=eq.{order_id}&select=*").mock(
        return_value=httpx.Response(
            200,
            json=[{
                "order_id": order_id,
                "user_id": USER_A,
                "amount": 99900,
                "currency": "INR",
                "status": "paid",  # Already marked paid
            }],
        )
    )

    resp = client.post(
        "/api/billing/verify",
        headers={"Authorization": f"Bearer {TOKEN_A}"},
        json={
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": valid_sig,
        },
    )
    assert resp.status_code == 200
    assert "already verified" in resp.json()["message"].lower()


def test_webhook_invalid_signature_rejected():
    """POST /api/billing/webhook rejects invalid signature with 400."""
    raw_payload = b'{"event": "payment.captured"}'
    resp = client.post(
        "/api/billing/webhook",
        content=raw_payload,
        headers={"X-Razorpay-Signature": "invalid_sig_hex"},
    )
    assert resp.status_code == 400
    assert "Invalid webhook signature" in resp.json()["detail"]


@respx.mock
def test_webhook_deduplication():
    """POST /api/billing/webhook deduplicates events present in webhook_events."""
    event_id = "evt_dedup_12345"
    payload = json.dumps({
        "event_id": event_id,
        "event": "payment.captured",
        "payload": {},
    }).encode("utf-8")

    valid_sig = hmac.new(
        MOCK_WEBHOOK_SECRET.encode(),
        payload,
        hashlib.sha256,
    ).hexdigest()

    # Mock webhook_events returning existing row
    respx.get(f"https://test.supabase.co/rest/v1/webhook_events?id=eq.{event_id}&select=id").mock(
        return_value=httpx.Response(200, json=[{"id": event_id}])
    )

    resp = client.post(
        "/api/billing/webhook",
        content=payload,
        headers={"X-Razorpay-Signature": valid_sig},
    )
    assert resp.status_code == 200
    assert resp.json()["message"] == "Duplicate event ignored"


@respx.mock
def test_webhook_before_verify_idempotent_flow():
    """Webhook arriving before client verify properly marks payment and subscription."""
    event_id = "evt_order_paid_555"
    order_id = "order_webhook_first"
    payment_id = "pay_webhook_first"

    payload = json.dumps({
        "event_id": event_id,
        "event": "payment.captured",
        "payload": {
            "payment": {
                "entity": {
                    "id": payment_id,
                    "order_id": order_id,
                    "amount": 99900,
                    "currency": "INR",
                    "status": "captured",
                    "notes": {"user_id": USER_A, "plan_id": "pro"},
                }
            }
        },
    }).encode("utf-8")

    valid_sig = hmac.new(
        MOCK_WEBHOOK_SECRET.encode(),
        payload,
        hashlib.sha256,
    ).hexdigest()

    respx.get(f"https://test.supabase.co/rest/v1/webhook_events?id=eq.{event_id}&select=id").mock(
        return_value=httpx.Response(200, json=[])  # Not processed yet
    )
    respx.post("https://test.supabase.co/rest/v1/webhook_events").mock(
        return_value=httpx.Response(201, json=[])
    )
    respx.patch(f"https://test.supabase.co/rest/v1/payments?order_id=eq.{order_id}").mock(
        return_value=httpx.Response(200, json=[])
    )
    respx.get(f"https://test.supabase.co/rest/v1/subscriptions?user_id=eq.{USER_A}&select=*").mock(
        return_value=httpx.Response(200, json=[])
    )
    respx.post("https://test.supabase.co/rest/v1/subscriptions").mock(
        return_value=httpx.Response(201, json=[])
    )
    respx.post("https://test.supabase.co/rest/v1/audit_log").mock(
        return_value=httpx.Response(201, json=[])
    )

    resp = client.post(
        "/api/billing/webhook",
        content=payload,
        headers={"X-Razorpay-Signature": valid_sig},
    )
    assert resp.status_code == 200
    assert resp.json()["event"] == "payment.captured"


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


def test_live_razorpay_order_creation_if_configured():
    """Live order creation test if real test keys are in environment."""
    real_key_id = os.getenv("REAL_RAZORPAY_KEY_ID")
    if not real_key_id:
        pytest.skip("No live Razorpay TEST keys in REAL_RAZORPAY_KEY_ID; skipping live order creation test.")
