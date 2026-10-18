"""
Main FastAPI Application for TaskPilot Graph.
Hosts:
- REST API: GET /, GET /api/tasks, POST /api/tasks, DELETE /api/tasks/{id},
            GET /api/graph, POST /api/agent, POST /api/approve, POST /api/admin/reset,
            GET /api/workspaces, POST /api/workspaces, DELETE /api/workspaces/{id}
- Streamable MCP Server: mounted at /mcp
- CORS support with explicit ALLOWED_ORIGIN allowlist
- Security headers: X-Content-Type-Options nosniff, Referrer-Policy no-referrer, Cache-Control no-store on authenticated routes
- Workspace isolation via Supabase RLS and FalkorDB per-workspace graphs
"""

import os
import re
import time
import hmac
import logging
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, Request, Response, Header, HTTPException, status, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.graph import (
    get_graph,
    get_all_tasks,
    get_graph_visualization,
    create_task,
    delete_task,
    delete_workspace_graph,
)
from app.seed import reset_and_seed
from app.mcp_server import mcp
from app.agent import run_agent
from app.approve import process_approvals
from app.auth import (
    get_current_user,
    get_optional_user,
    verify_supabase_jwt,
    extract_bearer_token,
    validate_workspace_id,
    create_workspace_in_db,
    list_workspaces_for_user,
    get_workspace_for_user,
    update_workspace_last_used,
    delete_workspace_in_db,
    UserClaims,
)
from app.billing import (
    write_audit_log,
    get_user_plan_id,
    get_plan_details,
    consume_quota,
    get_usage_today,
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("taskpilot")

# Rate limit configuration
RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "10"))
DAILY_AGENT_CAP = int(os.getenv("DAILY_AGENT_CAP", "500"))

# In-memory IP tracking for public demo rate limiting
_ip_requests: Dict[str, List[float]] = defaultdict(list)
_daily_requests: Dict[str, List[float]] = defaultdict(list)


def _check_rate_limit(ip: str) -> Optional[int]:
    """
    Checks per-minute and per-day rate limits for client IP on public demo.
    Returns retry_after_seconds if rate limited, or None if allowed.
    """
    now = time.time()
    min_window = 60.0
    day_window = 86400.0

    # Clean up older timestamps
    _ip_requests[ip] = [t for t in _ip_requests[ip] if now - t < min_window]
    _daily_requests[ip] = [t for t in _daily_requests[ip] if now - t < day_window]

    # Check 1-minute window
    if len(_ip_requests[ip]) >= RATE_LIMIT_PER_MIN:
        oldest = _ip_requests[ip][0]
        retry_after = max(1, int(min_window - (now - oldest)))
        return retry_after

    # Check 1-day cap
    if len(_daily_requests[ip]) >= DAILY_AGENT_CAP:
        oldest = _daily_requests[ip][0]
        retry_after = max(1, int(day_window - (now - oldest)))
        return retry_after

    # Record current request
    _ip_requests[ip].append(now)
    _daily_requests[ip].append(now)
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager that starts the FastMCP session manager."""
    async with mcp.session_manager.run():
        yield


app = FastAPI(
    title="TaskPilot Graph Backend",
    description="FalkorDB-powered autonomous agent acting on connected project data.",
    version="1.1.0",
    lifespan=lifespan,
)

# Configure CORS with explicit allowlist from ALLOWED_ORIGIN env var
allowed_origin_env = os.getenv("ALLOWED_ORIGIN", "")
if allowed_origin_env.strip():
    allowed_origins = [o.strip() for o in allowed_origin_env.split(",") if o.strip()]
else:
    allowed_origins = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["Authorization", "Content-Type", "X-Workspace", "X-Admin-Token"],
)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    """
    Applies security hardening:
    - 64KB request body size cap to mitigate Denial-of-Service
    - X-Content-Type-Options: nosniff
    - Referrer-Policy: no-referrer
    - Cache-Control: no-store on authenticated routes
    """
    if request.method in ("POST", "PUT", "PATCH"):
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > 65536:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "Payload too large. Maximum request body size is 64KB."},
                    )
            except ValueError:
                pass
        body = await request.body()
        if len(body) > 65536:
            return JSONResponse(
                status_code=413,
                content={"detail": "Payload too large. Maximum request body size is 64KB."},
            )

    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.headers.get("Authorization"):
        response.headers["Cache-Control"] = "no-store"
    return response


# Mount MCP streamable HTTP application at /mcp
app.mount("/mcp", mcp.streamable_http_app())


# ==============================================================================
# Helper to resolve target FalkorDB graph for request
# ==============================================================================

async def resolve_target_graph(
    request: Request,
    x_workspace: Optional[str] = None,
):
    """
    Resolves the active FalkorDB graph for the request:
    - If x_workspace is provided:
        1. Validates x_workspace is a UUID.
        2. Requires Authorization Bearer JWT.
        3. Loads workspace row via PostgREST with user's JWT.
        4. If RLS hides it or not found, returns identical 404 (never reveal existence).
        5. The FalkorDB graph name comes ONLY from the row (row['graph_name']).
        6. Updates last_used_at.
        7. Returns (get_graph(graph_name), ws_row).
    - If x_workspace is omitted:
        Returns (get_graph(), None) [public demo graph].
    """
    if not x_workspace:
        return get_graph(), None

    # 1. Validate UUID syntax
    valid_uuid = validate_workspace_id(x_workspace)

    # 2. Extract and verify user JWT
    token = extract_bearer_token(request)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required when accessing a workspace",
        )
    claims = verify_supabase_jwt(token)

    # 3. Load workspace with user's JWT through PostgREST (RLS enforced)
    ws_row = await get_workspace_for_user(claims.raw_token, valid_uuid)
    if not ws_row:
        # Return identical 404 without revealing existence
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        )

    # 4. Extract FalkorDB graph name solely from row
    graph_name = ws_row.get("graph_name")
    if not graph_name or graph_name.strip().lower() == "taskpilot":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid workspace graph configuration",
        )

    # 5. Update last_used_at
    await update_workspace_last_used(claims.raw_token, valid_uuid)

    return get_graph(graph_name), ws_row


# ==============================================================================
# REST Endpoints
# ==============================================================================

@app.get("/")
def root():
    """Healthcheck and system index."""
    return {
        "status": "ok",
        "service": "TaskPilot Graph",
        "database": "FalkorDB",
        "mcp": "/mcp",
        "docs": "/docs",
        "description": "Agent acting on connected graph data powered by FalkorDB",
    }


# --- Workspaces Endpoints ---

class WorkspaceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)


@app.post("/api/workspaces", status_code=status.HTTP_201_CREATED)
async def create_workspace(
    payload: WorkspaceCreate,
    current_user: UserClaims = Depends(get_current_user),
):
    """
    Creates a new workspace row in Supabase workspaces table with user's JWT.
    Trigger sets graph_name, 7-day expiry for guests, and enforces workspace quota.
    """
    ws = await create_workspace_in_db(current_user.raw_token, payload.name)
    return ws


@app.get("/api/workspaces")
async def list_workspaces(
    current_user: UserClaims = Depends(get_current_user),
):
    """Lists all workspaces owned by or accessible to the current user."""
    workspaces = await list_workspaces_for_user(current_user.raw_token)
    return workspaces


@app.delete("/api/workspaces/{workspace_id}")
async def delete_workspace(
    workspace_id: str,
    current_user: UserClaims = Depends(get_current_user),
):
    """
    Deletes a workspace:
    1. Loads workspace row with user's JWT (404 if not found or RLS hides it).
    2. Deletes the FalkorDB graph first (verifying NOT 'taskpilot').
    3. Deletes the row via PostgREST with user's JWT.
    """
    valid_id = validate_workspace_id(workspace_id)
    ws_row = await get_workspace_for_user(current_user.raw_token, valid_id)
    if not ws_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")

    graph_name = ws_row.get("graph_name")
    if graph_name:
        delete_workspace_graph(graph_name)

    deleted = await delete_workspace_in_db(current_user.raw_token, valid_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found or already deleted")

    await write_audit_log(
        "workspace_deleted",
        user_id=current_user.sub,
        details={"workspace_id": valid_id, "graph_name": graph_name},
    )

    return {"status": "ok", "message": "Workspace deleted successfully"}


# --- Tasks Endpoints ---

class TaskCreateInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    owner: str = Field(..., min_length=1, max_length=100)
    ownerEmail: Optional[str] = None
    manager: Optional[str] = None
    project: str = Field(..., min_length=1, max_length=100)
    deadline: Optional[str] = None
    status: str = Field(default="Pending", max_length=50)
    dependsOn: List[int] = Field(default_factory=list)


@app.get("/api/tasks")
async def list_tasks(
    request: Request,
    x_workspace: Optional[str] = Header(None, alias="X-Workspace"),
):
    """Returns all tasks in the active FalkorDB graph (demo or workspace)."""
    g, _ = await resolve_target_graph(request, x_workspace)
    try:
        tasks = get_all_tasks(g)
        return tasks
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Database error: {str(e)}"},
        )


@app.post("/api/tasks", status_code=status.HTTP_201_CREATED)
async def add_task(
    payload: TaskCreateInput,
    request: Request,
    x_workspace: Optional[str] = Header(None, alias="X-Workspace"),
):
    """
    Creates a new task with strict validation, dependency-cycle rejection, and plan task cap.
    Public demo graph is read-only (returns 403 if X-Workspace is not provided).
    """
    if not x_workspace:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The public demo graph is read-only for add/delete",
        )

    g, ws_row = await resolve_target_graph(request, x_workspace)

    # Enforce plan quota: max_tasks_per_workspace
    claims = await get_optional_user(request)
    if claims:
        plan_id = await get_user_plan_id(claims.sub)
        plan = await get_plan_details(plan_id)
        max_tasks = plan.get("max_tasks_per_workspace", 50)
        existing_tasks = get_all_tasks(g)
        if len(existing_tasks) >= max_tasks:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Plan limit reached: maximum {max_tasks} tasks allowed for {plan.get('name', 'Free')} plan",
            )

    # Validate deadline format if provided
    deadline_val = payload.deadline
    if deadline_val:
        deadline_clean = deadline_val.strip()
        if deadline_clean:
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", deadline_clean):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid deadline format. Expected YYYY-MM-DD",
                )
            deadline_val = deadline_clean
        else:
            deadline_val = None

    # Validate email format if provided
    email_val = payload.ownerEmail
    if email_val:
        email_clean = email_val.strip()
        if email_clean and ("@" not in email_clean or "." not in email_clean):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid ownerEmail format",
            )
        email_val = email_clean or None

    try:
        created = create_task(g, {
            "name": payload.name,
            "owner": payload.owner,
            "ownerEmail": email_val,
            "manager": payload.manager,
            "project": payload.project,
            "deadline": deadline_val,
            "status": payload.status,
            "dependsOn": payload.dependsOn,
        })
        return created
    except ValueError as ve:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(ve))
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Database error: {str(e)}"})


@app.delete("/api/tasks/{task_id}")
async def remove_task(
    task_id: int,
    request: Request,
    x_workspace: Optional[str] = Header(None, alias="X-Workspace"),
):
    """
    Deletes a task by ID.
    Public demo graph is read-only (returns 403 if X-Workspace is not provided).
    """
    if not x_workspace:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The public demo graph is read-only for add/delete",
        )

    if task_id <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Task ID must be a positive integer")

    g, ws_row = await resolve_target_graph(request, x_workspace)

    try:
        deleted = delete_task(g, task_id)
        if not deleted:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Task {task_id} not found")
        return {"status": "ok", "message": f"Task {task_id} deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Database error: {str(e)}"})


# --- Graph Topology Endpoint ---

@app.get("/api/graph")
async def graph_topology(
    request: Request,
    x_workspace: Optional[str] = Header(None, alias="X-Workspace"),
):
    """Returns full graph visualization topology (nodes & edges) for dashboards."""
    g, _ = await resolve_target_graph(request, x_workspace)
    try:
        return get_graph_visualization(g)
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Database error: {str(e)}"},
        )


# --- Agent Execution Endpoint ---

@app.post("/api/agent")
async def execute_agent(
    request: Request,
    x_workspace: Optional[str] = Header(None, alias="X-Workspace"),
):
    """
    Executes the agent audit cycle.
    Validates instruction, enforces IP rate limits on public demo, and executes traversal.
    """
    # 1. Parse and validate JSON body if present
    instruction = "Find overdue tasks and prepare reminders."
    try:
        body = await request.json()
        if isinstance(body, dict):
            inst = body.get("instruction")
            if isinstance(inst, str) and inst.strip():
                instruction = inst.strip()
    except Exception:
        pass

    if len(instruction) > 500:
        return JSONResponse(
            status_code=400,
            content={"error": "Instruction exceeds maximum length of 500 characters"},
        )

    # 2. Rate limit check for public demo vs server-side quota for workspaces
    if not x_workspace:
        client_ip = request.client.host if request.client else "127.0.0.1"
        retry_after = _check_rate_limit(client_ip)
        if retry_after is not None:
            return JSONResponse(
                status_code=429,
                content={"error": "Rate limit exceeded", "retryAfterSeconds": retry_after},
                headers={"Retry-After": str(retry_after)},
            )
    else:
        claims = await get_optional_user(request)
        if claims:
            plan_id = await get_user_plan_id(claims.sub)
            plan = await get_plan_details(plan_id)
            limit = plan.get("daily_agent_runs", 10)
            allowed = await consume_quota(claims.sub, "agent", limit)
            if not allowed:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Daily limit reached for your plan",
                )

    # 3. Resolve target graph
    g, ws_row = await resolve_target_graph(request, x_workspace)

    # 4. Execute agent loop on target graph
    try:
        result = await run_agent(graph=g)
        return result
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Database error: {str(e)}"},
        )


# --- Approval Endpoint ---

@app.post("/api/approve")
async def approve_actions(
    request: Request,
    x_workspace: Optional[str] = Header(None, alias="X-Workspace"),
):
    """
    Human approval endpoint for reminder actions.
    Accepts { actions: [...] } or { actionIds: [...] }.
    """
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})

    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"error": "Invalid request body: expected JSON object"})

    items = payload.get("actions") if "actions" in payload else payload.get("actionIds")
    if items is None or not isinstance(items, list):
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid request body: must contain 'actions' or 'actionIds' array"},
        )

    if len(items) == 0:
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid request body: 'actions' or 'actionIds' cannot be empty"},
        )

    g, _ = await resolve_target_graph(request, x_workspace)

    try:
        result = process_approvals(payload, graph=g)
        return result
    except ValueError as ve:
        return JSONResponse(status_code=400, content={"error": str(ve)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Database error: {str(e)}"})


# --- Admin Reset Endpoint ---

@app.post("/api/admin/reset")
async def admin_reset(request: Request, x_admin_token: Optional[str] = Header(None)):
    """
    Resets the FalkorDB demo graph to clean state and re-seeds synthetic entities.
    Requires matching X-Admin-Token header.
    """
    expected_token = os.getenv("ADMIN_TOKEN")
    if not x_admin_token or not expected_token or not hmac.compare_digest(x_admin_token, expected_token):
        return JSONResponse(
            status_code=401,
            content={"error": "Unauthorized: invalid or missing X-Admin-Token header"},
        )

    g = get_graph()
    seed_result = reset_and_seed(g)
    return {
        "status": "ok",
        "message": "Graph reset and re-seeded successfully",
        "details": seed_result,
    }


# --- Admin Cleanup Endpoint ---

@app.post("/api/admin/cleanup")
async def admin_cleanup(
    request: Request,
    x_admin_token: Optional[str] = Header(None),
):
    """
    Deletes expired workspaces and stale anonymous users older than 7 days.
    Requires matching X-Admin-Token header.
    FalkorDB graph deletion strictly enforces that 'taskpilot' graph is NEVER deleted.
    """
    expected_token = os.getenv("ADMIN_TOKEN")
    if not x_admin_token or not expected_token or not hmac.compare_digest(x_admin_token, expected_token):
        return JSONResponse(
            status_code=401,
            content={"error": "Unauthorized: invalid or missing X-Admin-Token header"},
        )

    deleted_workspaces = 0
    deleted_users = 0
    now_iso = datetime.now(timezone.utc).isoformat()
    seven_days_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

    # 1. Clean up expired workspaces
    if supabase_url and service_key:
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.get(
                    f"{supabase_url}/rest/v1/workspaces?expires_at=lt.{now_iso}&select=*",
                    headers=headers,
                )
                if res.status_code == 200:
                    expired_ws = res.json()
                    for ws in expired_ws:
                        ws_id = ws.get("id")
                        graph_name = ws.get("graph_name")
                        if graph_name and graph_name.strip().lower() != "taskpilot":
                            try:
                                delete_workspace_graph(graph_name)
                            except Exception as e:
                                logger.warning("Failed to delete graph %s during cleanup: %s", graph_name, e)

                        await client.delete(
                            f"{supabase_url}/rest/v1/workspaces?id=eq.{ws_id}",
                            headers=headers,
                        )
                        await write_audit_log(
                            "workspace_deleted",
                            user_id=ws.get("owner_id"),
                            details={"workspace_id": ws_id, "reason": "expired_cleanup"},
                        )
                        deleted_workspaces += 1
        except Exception as e:
            logger.warning("Error during workspace cleanup: %s", e)

        # 2. Clean up stale anonymous users older than 7 days
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                users_res = await client.get(
                    f"{supabase_url}/auth/v1/admin/users",
                    headers=headers,
                )
                if users_res.status_code == 200:
                    user_list = users_res.json().get("users", [])
                    for u in user_list:
                        is_anon = u.get("is_anonymous", False)
                        created_at = u.get("created_at")
                        if is_anon and created_at and created_at < seven_days_ago:
                            uid = u.get("id")
                            del_res = await client.delete(
                                f"{supabase_url}/auth/v1/admin/users/{uid}",
                                headers=headers,
                            )
                            if del_res.status_code in (200, 204):
                                deleted_users += 1
        except Exception as e:
            logger.warning("Error during stale user cleanup: %s", e)

    return {
        "status": "ok",
        "deleted_workspaces": deleted_workspaces,
        "deleted_users": deleted_users,
    }


# ==============================================================================
# Billing & Quotas Endpoints
# ==============================================================================

@app.get("/api/billing/me")
async def get_my_billing(
    current_user: UserClaims = Depends(get_current_user),
):
    """
    Returns user plan ID (from plan_id_for RPC), limits from plans table, and usage today.
    """
    plan_id = await get_user_plan_id(current_user.sub)
    plan = await get_plan_details(plan_id)
    usage = await get_usage_today(current_user.sub)
    return {
        "plan": plan_id,
        "planName": plan.get("name", "Free"),
        "limits": plan,
        "usage": usage,
        "isGuest": current_user.is_anonymous,
    }


@app.post("/api/github/import")
async def github_import(
    request: Request,
    current_user: UserClaims = Depends(get_current_user),
):
    """
    Enforces that GitHub import is restricted to plans that support it (Pro).
    """
    plan_id = await get_user_plan_id(current_user.sub)
    plan = await get_plan_details(plan_id)
    if not plan.get("github_import_allowed", False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="GitHub import is not available on your current plan. Upgrade to Pro.",
        )
    return {"status": "ok", "message": "GitHub import authorized for your plan"}
