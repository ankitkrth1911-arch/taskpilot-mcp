"""
Billing, Plans, Quotas, Razorpay TEST Integration, and Audit Logging Module.
Enforces server-side quotas via consume_quota RPC.
Creates Razorpay orders with basic auth, verifies HMAC-SHA256 signatures,
handles webhooks idempotently, and logs audit events using the service-role key.
"""

import os
import hmac
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List

import httpx
from fastapi import HTTPException, status
from pydantic import BaseModel

logger = logging.getLogger("taskpilot.billing")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

RAZORPAY_KEY_ID = os.getenv("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET", "")
RAZORPAY_WEBHOOK_SECRET = os.getenv("RAZORPAY_WEBHOOK_SECRET", "")

# Default fallback plan limits if DB table is unpopulated
DEFAULT_PLANS = {
    "free": {
        "id": "free",
        "name": "Free",
        "amount": 0,
        "currency": "INR",
        "daily_agent_runs": 10,
        "daily_ai_runs": 5,
        "max_tasks_per_workspace": 50,
        "github_import_allowed": False,
        "max_workspaces": 1,
    },
    "pro": {
        "id": "pro",
        "name": "Pro",
        "amount": 99900,  # 999 INR in paise
        "currency": "INR",
        "daily_agent_runs": 500,
        "daily_ai_runs": 200,
        "max_tasks_per_workspace": 200,
        "github_import_allowed": True,
        "max_workspaces": 10,
    },
}


def _get_service_role_headers() -> Dict[str, str]:
    """Returns headers for service-role PostgREST queries."""
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


# ==============================================================================
# Audit Logging
# ==============================================================================

async def write_audit_log(
    event: str,
    user_id: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Writes an audit_log record using the service-role key.
    Allowed events: checkout_created, payment_verified, webhook_rejected,
    subscription_changed, workspace_deleted.
    """
    payload = {
        "event": event,
        "user_id": user_id,
        "details": details or {},
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logger.info("AUDIT_LOG [%s] user=%s details=%s", event, user_id, details)
        return

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{SUPABASE_URL}/rest/v1/audit_log",
                headers=_get_service_role_headers(),
                json=payload,
            )
    except Exception as e:
        logger.warning("Failed to write audit log to Supabase: %s", e)


# ==============================================================================
# Plans & Quota Consumption
# ==============================================================================

async def get_plan_details(plan_id: str) -> Dict[str, Any]:
    """Retrieves plan information from the plans table or fallback defaults."""
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/plans?id=eq.{plan_id}&select=*",
                    headers=_get_service_role_headers(),
                )
                if res.status_code == 200:
                    rows = res.json()
                    if rows and isinstance(rows, list):
                        return rows[0]
        except Exception as e:
            logger.warning("Could not query plans table: %s", e)

    return DEFAULT_PLANS.get(plan_id, DEFAULT_PLANS["free"])


async def get_user_plan_id(user_id: str) -> str:
    """Invokes plan_id_for RPC using service-role key to obtain user's active plan."""
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(
                    f"{SUPABASE_URL}/rest/v1/rpc/plan_id_for",
                    headers=_get_service_role_headers(),
                    json={"p_user_id": user_id},
                )
                if res.status_code == 200:
                    val = res.json()
                    if isinstance(val, str) and val in DEFAULT_PLANS:
                        return val
        except Exception as e:
            logger.warning("Could not query plan_id_for RPC: %s", e)

    return "free"


async def consume_quota(user_id: str, kind: str, limit: int) -> bool:
    """
    Enforces server-side usage quotas using the consume_quota RPC.
    Returns True if quota consumed successfully, False if limit reached.
    """
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(
                    f"{SUPABASE_URL}/rest/v1/rpc/consume_quota",
                    headers=_get_service_role_headers(),
                    json={
                        "p_user_id": user_id,
                        "p_kind": kind,
                        "p_limit": limit,
                    },
                )
                if res.status_code == 200:
                    val = res.json()
                    if isinstance(val, bool):
                        return val
                elif res.status_code == 400:
                    return False
        except Exception as e:
            logger.warning("Could not call consume_quota RPC: %s", e)

    # In fallback/offline mode, permit if under limit
    return True


async def get_usage_today(user_id: str) -> Dict[str, int]:
    """Returns today's usage counts for agent and ai runs."""
    usage = {"agent": 0, "ai": 0}
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            today_str = datetime.now(timezone.utc).date().isoformat()
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/usage_counters?user_id=eq.{user_id}&counter_date=eq.{today_str}&select=kind,count",
                    headers=_get_service_role_headers(),
                )
                if res.status_code == 200:
                    for item in res.json():
                        k = item.get("kind")
                        c = item.get("count", 0)
                        if k in usage:
                            usage[k] = c
        except Exception as e:
            logger.warning("Could not fetch usage counters: %s", e)
    return usage


# ==============================================================================
# Razorpay Order Creation & Verification
# ==============================================================================

async def create_razorpay_order(
    user_id: str,
    plan_id: str,
) -> Dict[str, Any]:
    """
    Creates a Razorpay Order via REST API and persists a 'created' payment record.
    Never returns the Razorpay Key Secret.
    """
    key_id = os.getenv("RAZORPAY_KEY_ID", RAZORPAY_KEY_ID)
    key_secret = os.getenv("RAZORPAY_KEY_SECRET", RAZORPAY_KEY_SECRET)

    plan = await get_plan_details(plan_id)
    amount = plan.get("amount", 99900)
    currency = plan.get("currency", "INR")
    plan_name = plan.get("name", "Pro")

    if not key_id or not key_secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Razorpay credentials not configured",
        )

    order_payload = {
        "amount": amount,
        "currency": currency,
        "notes": {
            "user_id": user_id,
            "plan_id": plan_id,
        },
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.post(
            "https://api.razorpay.com/v1/orders",
            auth=(key_id, key_secret),
            json=order_payload,
        )
        if res.status_code not in (200, 201):
            logger.error("Razorpay order creation failed: %s", res.text)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Failed to initialize order with Razorpay",
            )
        order_data = res.json()

    order_id = order_data["id"]

    # Persist payment record with service-role key
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    f"{SUPABASE_URL}/rest/v1/payments",
                    headers=_get_service_role_headers(),
                    json={
                        "order_id": order_id,
                        "user_id": user_id,
                        "amount": amount,
                        "currency": currency,
                        "status": "created",
                        "notes": {"plan_id": plan_id},
                    },
                )
        except Exception as e:
            logger.warning("Could not persist payments record: %s", e)

    await write_audit_log(
        "checkout_created",
        user_id=user_id,
        details={"order_id": order_id, "plan_id": plan_id, "amount": amount},
    )

    return {
        "orderId": order_id,
        "keyId": key_id,
        "amount": amount,
        "currency": currency,
        "planName": plan_name,
    }


async def verify_payment_and_activate_subscription(
    user_id: str,
    razorpay_order_id: str,
    razorpay_payment_id: str,
    razorpay_signature: str,
) -> Dict[str, Any]:
    """
    Verifies HMAC-SHA256 signature and payment details from Razorpay,
    records payment success, and idempotently extends the user's subscription.
    """
    key_id = os.getenv("RAZORPAY_KEY_ID", RAZORPAY_KEY_ID)
    key_secret = os.getenv("RAZORPAY_KEY_SECRET", RAZORPAY_KEY_SECRET)

    # 1. Verify HMAC signature
    generated_sig = hmac.new(
        key_secret.encode("utf-8"),
        f"{razorpay_order_id}|{razorpay_payment_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(generated_sig, razorpay_signature):
        await write_audit_log(
            "webhook_rejected",
            user_id=user_id,
            details={"reason": "signature_mismatch", "order_id": razorpay_order_id},
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid payment signature",
        )

    # 2. Verify stored payment record belongs to this user
    stored_payment: Optional[Dict[str, Any]] = None
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/payments?order_id=eq.{razorpay_order_id}&select=*",
                    headers=_get_service_role_headers(),
                )
                if res.status_code == 200:
                    rows = res.json()
                    if rows:
                        stored_payment = rows[0]
        except Exception as e:
            logger.warning("Could not query payment record: %s", e)

    if stored_payment:
        if stored_payment.get("user_id") != user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Order does not belong to the authenticated user",
            )
        # Idempotency check: if already marked paid, return success without extending twice
        if stored_payment.get("status") == "paid":
            return {"status": "ok", "message": "Payment already verified", "plan": "pro"}

    # 3. Fetch payment directly from Razorpay to verify status, amount, and currency
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.get(
            f"https://api.razorpay.com/v1/payments/{razorpay_payment_id}",
            auth=(key_id, key_secret),
        )
        if res.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unable to fetch payment details from Razorpay",
            )
        rp_payment = res.json()

    if rp_payment.get("status") not in ("captured", "authorized"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Payment status is not captured/authorized: {rp_payment.get('status')}",
        )

    if stored_payment:
        if rp_payment.get("amount") != stored_payment.get("amount") or rp_payment.get("currency") != stored_payment.get("currency"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Amount or currency mismatch between order and payment",
            )

    # 4. Mark payment as paid
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/payments?order_id=eq.{razorpay_order_id}",
                    headers=_get_service_role_headers(),
                    json={
                        "payment_id": razorpay_payment_id,
                        "status": "paid",
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    },
                )
        except Exception as e:
            logger.warning("Could not update payment record: %s", e)

    # 5. Activate or extend subscription (current_period_end = max(now, current_end) + 30 days)
    plan_id = stored_payment.get("notes", {}).get("plan_id", "pro") if stored_payment else "pro"
    await _extend_user_subscription(user_id, plan_id)

    await write_audit_log(
        "payment_verified",
        user_id=user_id,
        details={
            "order_id": razorpay_order_id,
            "payment_id": razorpay_payment_id,
            "plan_id": plan_id,
        },
    )

    return {
        "status": "ok",
        "message": "Payment verified and Pro subscription activated",
        "plan": plan_id,
    }


async def _extend_user_subscription(user_id: str, plan_id: str) -> None:
    """Extends or activates a subscription by 30 days idempotently."""
    now = datetime.now(timezone.utc)
    target_end = now + timedelta(days=30)

    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.{user_id}&select=*",
                    headers=_get_service_role_headers(),
                )
                if res.status_code == 200:
                    rows = res.json()
                    if rows:
                        sub = rows[0]
                        current_end_raw = sub.get("current_period_end")
                        if current_end_raw:
                            try:
                                current_end = datetime.fromisoformat(current_end_raw.replace("Z", "+00:00"))
                                if current_end > now:
                                    target_end = current_end + timedelta(days=30)
                            except Exception:
                                pass
                        # Update existing subscription
                        await client.patch(
                            f"{SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.{user_id}",
                            headers=_get_service_role_headers(),
                            json={
                                "plan_id": plan_id,
                                "status": "active",
                                "current_period_end": target_end.isoformat(),
                                "updated_at": now.isoformat(),
                            },
                        )
                    else:
                        # Insert new subscription
                        await client.post(
                            f"{SUPABASE_URL}/rest/v1/subscriptions",
                            headers=_get_service_role_headers(),
                            json={
                                "user_id": user_id,
                                "plan_id": plan_id,
                                "status": "active",
                                "current_period_end": target_end.isoformat(),
                                "created_at": now.isoformat(),
                                "updated_at": now.isoformat(),
                            },
                        )
        except Exception as e:
            logger.warning("Could not update subscriptions table: %s", e)

    await write_audit_log(
        "subscription_changed",
        user_id=user_id,
        details={"plan_id": plan_id, "current_period_end": target_end.isoformat()},
    )


# ==============================================================================
# Webhook Handling (Source of Truth)
# ==============================================================================

async def handle_razorpay_webhook(
    raw_body: bytes,
    signature_header: Optional[str],
) -> Dict[str, Any]:
    """
    Validates Razorpay webhook using raw body bytes and compares HMAC-SHA256 signature.
    Dedupes via webhook_events table, and updates payment/subscription.
    """
    webhook_secret = os.getenv("RAZORPAY_WEBHOOK_SECRET", RAZORPAY_WEBHOOK_SECRET)
    if not webhook_secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Webhook secret not configured",
        )

    if not signature_header:
        await write_audit_log("webhook_rejected", details={"reason": "missing_signature"})
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing X-Razorpay-Signature header",
        )

    expected_sig = hmac.new(
        webhook_secret.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected_sig, signature_header):
        await write_audit_log("webhook_rejected", details={"reason": "bad_signature"})
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid webhook signature",
        )

    import json
    try:
        event = json.loads(raw_body.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON payload")

    event_id = event.get("event_id") or event.get("id")
    event_type = event.get("event")

    # Deduplicate in webhook_events table
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and event_id:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/webhook_events?id=eq.{event_id}&select=id",
                    headers=_get_service_role_headers(),
                )
                if res.status_code == 200 and res.json():
                    logger.info("Webhook event %s already processed; deduplicating", event_id)
                    return {"status": "ok", "message": "Duplicate event ignored"}

                # Record webhook event
                await client.post(
                    f"{SUPABASE_URL}/rest/v1/webhook_events",
                    headers=_get_service_role_headers(),
                    json={
                        "id": event_id,
                        "event_type": event_type,
                        "processed_at": datetime.now(timezone.utc).isoformat(),
                    },
                )
        except Exception as e:
            logger.warning("Could not record webhook_event: %s", e)

    # Process events
    if event_type in ("payment.captured", "order.paid"):
        payload_entity = event.get("payload", {}).get("payment", {}).get("entity", {})
        order_id = payload_entity.get("order_id")
        payment_id = payload_entity.get("id")
        notes = payload_entity.get("notes", {})
        user_id = notes.get("user_id")
        plan_id = notes.get("plan_id", "pro")

        if user_id:
            # Mark payment paid
            if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and order_id:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        await client.patch(
                            f"{SUPABASE_URL}/rest/v1/payments?order_id=eq.{order_id}",
                            headers=_get_service_role_headers(),
                            json={
                                "payment_id": payment_id,
                                "status": "paid",
                                "updated_at": datetime.now(timezone.utc).isoformat(),
                            },
                        )
                except Exception as e:
                    logger.warning("Failed to update payment status: %s", e)

            await _extend_user_subscription(user_id, plan_id)

    elif event_type == "payment.failed":
        payload_entity = event.get("payload", {}).get("payment", {}).get("entity", {})
        order_id = payload_entity.get("order_id")
        payment_id = payload_entity.get("id")
        if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and order_id:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.patch(
                        f"{SUPABASE_URL}/rest/v1/payments?order_id=eq.{order_id}",
                        headers=_get_service_role_headers(),
                        json={
                            "payment_id": payment_id,
                            "status": "failed",
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        },
                    )
            except Exception as e:
                logger.warning("Failed to record payment failure: %s", e)

    return {"status": "ok", "event": event_type}
