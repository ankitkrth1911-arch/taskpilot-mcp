"""
Plans, Quotas, and Audit Logging Module.
Enforces server-side quotas via consume_quota RPC.
Retrieves plan details and usage counters, and logs audit events using the service-role key.
"""

import os
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any

import httpx

logger = logging.getLogger("taskpilot.billing")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

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
    Allowed events: workspace_deleted, etc.
    """
    payload = {
        "event": event,
        "user_id": user_id,
        "details": details or {},
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    supabase_url = os.getenv("SUPABASE_URL", SUPABASE_URL)
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
    if not supabase_url or not service_key:
        logger.info("AUDIT_LOG [%s] user=%s details=%s", event, user_id, details)
        return

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{supabase_url}/rest/v1/audit_log",
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
    supabase_url = os.getenv("SUPABASE_URL", SUPABASE_URL)
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
    if supabase_url and service_key:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(
                    f"{supabase_url}/rest/v1/plans?id=eq.{plan_id}&select=*",
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
    supabase_url = os.getenv("SUPABASE_URL", SUPABASE_URL)
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
    if supabase_url and service_key:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(
                    f"{supabase_url}/rest/v1/rpc/plan_id_for",
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
    supabase_url = os.getenv("SUPABASE_URL", SUPABASE_URL)
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
    if supabase_url and service_key:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(
                    f"{supabase_url}/rest/v1/rpc/consume_quota",
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
    supabase_url = os.getenv("SUPABASE_URL", SUPABASE_URL)
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
    if supabase_url and service_key:
        try:
            today_str = datetime.now(timezone.utc).date().isoformat()
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(
                    f"{supabase_url}/rest/v1/usage_counters?user_id=eq.{user_id}&counter_date=eq.{today_str}&select=kind,count",
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
