"""
Main FastAPI Application for TaskPilot Graph.
Hosts:
- REST API: GET /, GET /api/tasks, GET /api/graph, POST /api/agent, POST /api/approve, POST /api/admin/reset
- Streamable MCP Server: mounted at /mcp
- CORS support and per-IP rate limiting
"""

import os
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Request, Response, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.graph import get_graph, get_all_tasks, get_graph_visualization
from app.seed import reset_and_seed
from app.mcp_server import mcp
from app.agent import run_agent
from app.approve import process_approvals

# Rate limit configuration
RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "10"))
DAILY_AGENT_CAP = int(os.getenv("DAILY_AGENT_CAP", "500"))
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN")

# In-memory IP tracking for rate limiting
# Key: ip -> list of timestamps
_ip_requests: Dict[str, List[float]] = defaultdict(list)
_daily_requests: Dict[str, List[float]] = defaultdict(list)


def _check_rate_limit(ip: str) -> Optional[int]:
    """
    Checks per-minute and per-day rate limits for client IP.
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
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS for external dashboards
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount MCP streamable HTTP application at /mcp
app.mount("/mcp", mcp.streamable_http_app())


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


@app.get("/api/tasks")
def list_tasks():
    """Returns all tasks in FalkorDB with owner, project, and status."""
    try:
        g = get_graph()
        tasks = get_all_tasks(g)
        return tasks
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Database error: {str(e)}"},
        )


@app.get("/api/graph")
def graph_topology():
    """Returns full graph visualization topology (nodes & edges) for dashboards."""
    try:
        g = get_graph()
        return get_graph_visualization(g)
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Database error: {str(e)}"},
        )


@app.post("/api/agent")
async def execute_agent(request: Request):
    """
    Executes the agent audit cycle.
    Validates instruction, enforces IP rate limits, and triggers graph traversal.
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
        # Non-JSON or empty body is permitted
        pass

    if len(instruction) > 500:
        return JSONResponse(
            status_code=400,
            content={"error": "Instruction exceeds maximum length of 500 characters"},
        )

    # 2. Rate limit check
    client_ip = request.client.host if request.client else "127.0.0.1"
    retry_after = _check_rate_limit(client_ip)
    if retry_after is not None:
        return JSONResponse(
            status_code=429,
            content={"error": "Rate limit exceeded", "retryAfterSeconds": retry_after},
            headers={"Retry-After": str(retry_after)},
        )

    # 3. Execute agent loop
    try:
        g = get_graph()
        result = await run_agent(graph=g)
        return result
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Database error: {str(e)}"},
        )


@app.post("/api/approve")
async def approve_actions(request: Request):
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

    try:
        g = get_graph()
        result = process_approvals(payload, graph=g)
        return result
    except ValueError as ve:
        return JSONResponse(status_code=400, content={"error": str(ve)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Database error: {str(e)}"})


@app.post("/api/admin/reset")
async def admin_reset(request: Request, x_admin_token: Optional[str] = Header(None)):
    """
    Resets the FalkorDB graph to clean state and re-seeds synthetic entities.
    Requires matching X-Admin-Token header.
    """
    expected_token = os.getenv("ADMIN_TOKEN")
    if not expected_token:
        return JSONResponse(
            status_code=404,
            content={"error": "Admin reset endpoint disabled: ADMIN_TOKEN not configured"},
        )
    import hmac
    if not x_admin_token or not hmac.compare_digest(x_admin_token, expected_token):
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
