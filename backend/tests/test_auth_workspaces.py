"""
Comprehensive Unit and Integration Tests for Phase 1:
- Supabase JWT verification:
  - Signature verification (JWKS / HS256)
  - Expired token -> 401
  - Tampered token -> 401
  - Wrong audience -> 401
  - Wrong issuer -> 401
  - alg='none' -> 401
  - Unexpected alg -> 401
  - Missing token on protected routes -> 401
- X-Workspace header validation:
  - UUID validation
  - SQL/path injection rejection -> 400
- Workspace isolation (Multi-tenant security):
  - User A cannot read, write, delete or run agent in User B's workspace (404 on every route)
  - Tasks of different users never mix
  - Deleting a workspace removes its FalkorDB graph (strictly verifying NOT 'taskpilot')
- Public demo endpoint behavior without Authorization header:
  - GET / -> 200
  - GET /api/tasks -> 200
  - GET /api/graph -> 200
  - POST /api/agent -> 200
  - POST /api/tasks -> 403 (read-only)
  - DELETE /api/tasks/{id} -> 403 (read-only)
- Real test users created via Supabase Auth API if live credentials configured (deleted afterwards)
"""

import os
import time
import uuid
import json
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock, AsyncMock

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient

from app.main import app
import app.auth as auth_module

client = TestClient(app)

# Generate RSA keypair for testing JWKS RS256 token verification
_private_key = rsa.generate_private_key(
    public_exponent=65537,
    key_size=2048,
)
_public_key = _private_key.public_key()
_pem_private = _private_key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode("utf-8")
_pem_public = _public_key.public_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PublicFormat.SubjectPublicKeyInfo,
).decode("utf-8")

TEST_SUPABASE_URL = "https://mock-project.supabase.co"
TEST_JWT_SECRET = "test-secret-key-that-is-at-least-32-bytes-long"


def create_test_jwt(
    sub: str,
    email: str = "user@test.com",
    is_anonymous: bool = False,
    aud: str = "authenticated",
    iss: str = f"{TEST_SUPABASE_URL}/auth/v1",
    exp_offset: int = 3600,
    alg: str = "HS256",
    secret: str = TEST_JWT_SECRET,
) -> str:
    now = int(time.time())
    payload = {
        "sub": sub,
        "email": email,
        "is_anonymous": is_anonymous,
        "aud": aud,
        "iss": iss,
        "iat": now,
        "exp": now + exp_offset,
        "role": "authenticated",
    }
    headers = {"alg": alg, "typ": "JWT"}
    if alg == "none":
        return jwt.encode(payload, key="", algorithm="none")
    return jwt.encode(payload, secret, algorithm=alg, headers=headers)


@pytest.fixture(autouse=True)
def setup_auth_env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", TEST_SUPABASE_URL)
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", TEST_JWT_SECRET)
    monkeypatch.setattr(auth_module, "SUPABASE_URL", TEST_SUPABASE_URL)
    monkeypatch.setattr(auth_module, "SUPABASE_ANON_KEY", "anon-key")
    monkeypatch.setattr(auth_module, "SUPABASE_JWT_SECRET", TEST_JWT_SECRET)


# ==============================================================================
# 1. Token Security Tests
# ==============================================================================

def test_token_missing_on_protected_workspaces_route():
    """Missing token on protected workspace routes gives 401."""
    resp = client.get("/api/workspaces")
    assert resp.status_code == 401
    assert "Missing Authorization" in resp.json().get("detail", "")

    resp_post = client.post("/api/workspaces", json={"name": "New WS"})
    assert resp_post.status_code == 401


def test_token_expired():
    """Expired tokens are rejected with 401."""
    expired_token = create_test_jwt(sub="user-123", exp_offset=-60)
    resp = client.get("/api/workspaces", headers={"Authorization": f"Bearer {expired_token}"})
    assert resp.status_code == 401
    assert "expired" in resp.json().get("detail", "").lower()


def test_token_tampered():
    """Tampered token signatures are rejected with 401."""
    valid_token = create_test_jwt(sub="user-123")
    parts = valid_token.split(".")
    tampered_token = f"{parts[0]}.{parts[1]}.tampered_signature"
    resp = client.get("/api/workspaces", headers={"Authorization": f"Bearer {tampered_token}"})
    assert resp.status_code == 401


def test_token_wrong_audience():
    """Token with wrong audience gives 401."""
    token = create_test_jwt(sub="user-123", aud="wrong_audience")
    resp = client.get("/api/workspaces", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401
    assert "audience" in resp.json().get("detail", "").lower()


def test_token_wrong_issuer():
    """Token with wrong issuer gives 401."""
    token = create_test_jwt(sub="user-123", iss="https://attacker.com/auth/v1")
    resp = client.get("/api/workspaces", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401
    assert "issuer" in resp.json().get("detail", "").lower()


def test_token_alg_none_rejected():
    """Tokens using alg=none must be rejected with 401."""
    none_token = create_test_jwt(sub="user-123", alg="none")
    resp = client.get("/api/workspaces", headers={"Authorization": f"Bearer {none_token}"})
    assert resp.status_code == 401
    assert "disallowed" in resp.json().get("detail", "").lower() or "algorithm" in resp.json().get("detail", "").lower()


def test_token_unexpected_algorithm_rejected():
    """Tokens using unexpected algorithms (e.g. HS512) are rejected with 401."""
    hs512_token = create_test_jwt(sub="user-123", alg="HS512", secret="x" * 64)
    resp = client.get("/api/workspaces", headers={"Authorization": f"Bearer {hs512_token}"})
    assert resp.status_code == 401
    assert "algorithm" in resp.json().get("detail", "").lower()


def test_token_rs256_jwks_support(monkeypatch):
    """Verifies RS256 token verification using mock JWKS signing key."""
    # Create RS256 token
    now = int(time.time())
    payload = {
        "sub": "user-rs256",
        "email": "rs256@test.com",
        "is_anonymous": False,
        "aud": "authenticated",
        "iss": f"{TEST_SUPABASE_URL}/auth/v1",
        "iat": now,
        "exp": now + 3600,
    }
    rs256_token = jwt.encode(payload, _pem_private, algorithm="RS256", headers={"kid": "key-1"})

    mock_jwk_client = MagicMock()
    mock_key = MagicMock()
    mock_key.key = _pem_public
    mock_jwk_client.get_signing_key_from_jwt.return_value = mock_key

    monkeypatch.setattr(auth_module, "get_jwks_client", lambda: mock_jwk_client)

    claims = auth_module.verify_supabase_jwt(rs256_token)
    assert claims.sub == "user-rs256"
    assert claims.is_anonymous is False


# ==============================================================================
# 2. X-Workspace Header & Injection Rejection Tests
# ==============================================================================

def test_x_workspace_injection_rejected():
    """Non-UUID strings, SQL injection, and path traversal in X-Workspace give 400."""
    token = create_test_jwt(sub="user-123")
    headers = {"Authorization": f"Bearer {token}"}

    injections = [
        "not-a-uuid",
        "' OR 1=1 --",
        "../../../etc/passwd",
        "<script>alert(1)</script>",
        "12345678-1234-1234-1234-12345678901z",  # invalid hex
    ]

    for bad in injections:
        bad_headers = {**headers, "X-Workspace": bad}
        resp = client.get("/api/tasks", headers=bad_headers)
        assert resp.status_code == 400
        assert "UUID" in resp.json().get("detail", "") or "UUID" in resp.json().get("error", "")


# ==============================================================================
# 3. Public Demo Endpoints Without Token
# ==============================================================================

def test_public_demo_endpoints_work_without_token():
    """Without Authorization header, public demo endpoints behave as before."""
    with patch("app.main.get_graph"), patch("app.main.get_all_tasks") as mock_tasks, \
         patch("app.main.get_graph_visualization") as mock_graph_vis, \
         patch("app.main.run_agent", new_callable=AsyncMock) as mock_agent, \
         patch("app.main.process_approvals") as mock_approve:

        mock_tasks.return_value = [{"id": 1, "name": "Demo task"}]
        mock_graph_vis.return_value = {"nodes": [], "edges": []}
        mock_agent.return_value = {"status": "ok", "summary": "Demo summary"}
        mock_approve.return_value = {"status": "ok"}

        # GET /
        resp_root = client.get("/")
        assert resp_root.status_code == 200
        assert resp_root.json()["service"] == "TaskPilot Graph"

        # GET /api/tasks
        resp_tasks = client.get("/api/tasks")
        assert resp_tasks.status_code == 200
        assert len(resp_tasks.json()) == 1

        # GET /api/graph
        resp_graph = client.get("/api/graph")
        assert resp_graph.status_code == 200

        # POST /api/agent
        resp_agent = client.post("/api/agent", json={"instruction": "Find overdue"})
        assert resp_agent.status_code == 200

        # POST /api/approve
        resp_appr = client.post("/api/approve", json={"actions": ["act_1"]})
        assert resp_appr.status_code == 200


def test_public_demo_is_readonly_for_modifications():
    """Adding or deleting tasks without X-Workspace on public demo gives 403."""
    # POST /api/tasks without workspace
    resp_post = client.post("/api/tasks", json={
        "name": "Add task in demo",
        "owner": "Rahul",
        "project": "Website Launch",
    })
    assert resp_post.status_code == 403
    assert "read-only" in resp_post.json().get("detail", "").lower()

    # DELETE /api/tasks/1 without workspace
    resp_del = client.delete("/api/tasks/1")
    assert resp_del.status_code == 403
    assert "read-only" in resp_del.json().get("detail", "").lower()


# ==============================================================================
# 4. Multi-Tenant Workspace Isolation Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_user_a_cannot_access_user_b_workspace():
    """
    User A cannot read, write, delete or run agent in User B's workspace (404 on every route).
    RLS hides it and server returns identical 404 without revealing existence.
    """
    user_a_token = create_test_jwt(sub="user-a", email="a@test.com")
    user_b_token = create_test_jwt(sub="user-b", email="b@test.com")
    ws_b_id = str(uuid.uuid4())

    # Mock PostgREST: User A cannot see User B's workspace row (RLS returns empty list)
    async def mock_get_workspace(token, ws_id):
        claims = auth_module.verify_supabase_jwt(token)
        if claims.sub == "user-b" and ws_id == ws_b_id:
            return {"id": ws_b_id, "name": "B's Workspace", "graph_name": "ws_b_graph"}
        return None  # Hidden by RLS for user A

    with patch("app.main.get_workspace_for_user", side_effect=mock_get_workspace):
        headers_a = {
            "Authorization": f"Bearer {user_a_token}",
            "X-Workspace": ws_b_id,
        }

        # GET /api/tasks -> 404
        r1 = client.get("/api/tasks", headers=headers_a)
        assert r1.status_code == 404
        assert "not found" in r1.json().get("detail", "").lower()

        # POST /api/tasks -> 404
        r2 = client.post("/api/tasks", headers=headers_a, json={
            "name": "Hack B's workspace",
            "owner": "Alice",
            "project": "Secret",
        })
        assert r2.status_code == 404

        # DELETE /api/tasks/1 -> 404
        r3 = client.delete("/api/tasks/1", headers=headers_a)
        assert r3.status_code == 404

        # GET /api/graph -> 404
        r4 = client.get("/api/graph", headers=headers_a)
        assert r4.status_code == 404

        # POST /api/agent -> 404
        r5 = client.post("/api/agent", headers=headers_a, json={"instruction": "Audit"})
        assert r5.status_code == 404

        # POST /api/approve -> 404
        r6 = client.post("/api/approve", headers=headers_a, json={"actions": ["act_1"]})
        assert r6.status_code == 404

        # DELETE /api/workspaces/{b_workspace_id} as user A -> 404
        r7 = client.delete(f"/api/workspaces/{ws_b_id}", headers={"Authorization": f"Bearer {user_a_token}"})
        assert r7.status_code == 404


def test_tasks_of_different_users_never_mix():
    """
    Verifies that tasks created in Workspace A and Workspace B stay in their respective graphs.
    """
    user_a_token = create_test_jwt(sub="user-a")
    user_b_token = create_test_jwt(sub="user-b")
    ws_a_id = str(uuid.uuid4())
    ws_b_id = str(uuid.uuid4())

    mock_graph_a = MagicMock()
    mock_graph_b = MagicMock()

    # Workspace A task return
    mock_graph_a.query.return_value.result_set = [
        [1, "Task of User A", "2026-10-20", "Pending", False, None, "Alice", "a@test.com", "Project A"]
    ]
    # Workspace B task return
    mock_graph_b.query.return_value.result_set = [
        [1, "Task of User B", "2026-10-22", "Pending", False, None, "Bob", "b@test.com", "Project B"]
    ]

    async def mock_get_workspace(token, ws_id):
        claims = auth_module.verify_supabase_jwt(token)
        if claims.sub == "user-a" and ws_id == ws_a_id:
            return {"id": ws_a_id, "name": "WS A", "graph_name": "ws_a_graph"}
        if claims.sub == "user-b" and ws_id == ws_b_id:
            return {"id": ws_b_id, "name": "WS B", "graph_name": "ws_b_graph"}
        return None

    def mock_get_graph(graph_name=None):
        if graph_name == "ws_a_graph":
            return mock_graph_a
        if graph_name == "ws_b_graph":
            return mock_graph_b
        return MagicMock()

    with patch("app.main.get_workspace_for_user", side_effect=mock_get_workspace), \
         patch("app.main.get_graph", side_effect=mock_get_graph), \
         patch("app.main.update_workspace_last_used", new_callable=AsyncMock):

        # User A reads WS A
        res_a = client.get("/api/tasks", headers={
            "Authorization": f"Bearer {user_a_token}",
            "X-Workspace": ws_a_id,
        })
        assert res_a.status_code == 200
        assert res_a.json()[0]["name"] == "Task of User A"
        assert res_a.json()[0]["owner"] == "Alice"

        # User B reads WS B
        res_b = client.get("/api/tasks", headers={
            "Authorization": f"Bearer {user_b_token}",
            "X-Workspace": ws_b_id,
        })
        assert res_b.status_code == 200
        assert res_b.json()[0]["name"] == "Task of User B"
        assert res_b.json()[0]["owner"] == "Bob"


def test_delete_workspace_removes_falkordb_graph():
    """
    Deleting a workspace deletes the FalkorDB graph first (verifying NOT 'taskpilot'),
    then deletes the row via PostgREST.
    """
    user_token = create_test_jwt(sub="user-del")
    ws_id = str(uuid.uuid4())
    ws_graph_name = f"ws_{ws_id.replace('-', '')}"

    async def mock_get_workspace(token, w_id):
        if w_id == ws_id:
            return {"id": ws_id, "name": "WS To Delete", "graph_name": ws_graph_name}
        return None

    with patch("app.main.get_workspace_for_user", side_effect=mock_get_workspace), \
         patch("app.main.delete_workspace_graph") as mock_del_graph, \
         patch("app.main.delete_workspace_in_db", new_callable=AsyncMock) as mock_del_db:

        mock_del_db.return_value = True

        resp = client.delete(f"/api/workspaces/{ws_id}", headers={"Authorization": f"Bearer {user_token}"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

        # Confirm graph deletion was called with the workspace graph name
        mock_del_graph.assert_called_once_with(ws_graph_name)
        assert ws_graph_name != "taskpilot"
        # Confirm PostgREST row deletion was called
        mock_del_db.assert_called_once()


def test_delete_protected_taskpilot_graph_refused():
    """Confirming that trying to delete or reset 'taskpilot' raises a safety error."""
    from app.graph import delete_workspace_graph, clear_graph

    with pytest.raises(ValueError) as exc:
        delete_workspace_graph("taskpilot")
    assert "protected graph 'taskpilot'" in str(exc.value)

    mock_graph = MagicMock()
    mock_graph.name = "taskpilot"
    with pytest.raises(ValueError) as exc2:
        clear_graph(mock_graph)
    assert "protected graph 'taskpilot'" in str(exc2.value)


# ==============================================================================
# 5. Task Creation: Cycle Detection & 200 Task Cap Tests
# ==============================================================================

def test_task_creation_cycle_rejection():
    """Cycles in task dependencies are strictly rejected with 400."""
    from app.graph import create_task

    mock_graph = MagicMock()
    # Task count < 200
    mock_graph.query.return_value.result_set = [[0]]

    # Existing tasks: 1 and 2
    # Edge: 1 depends on 2
    def mock_query(cypher, params=None):
        m = MagicMock()
        if "count(t) AS count" in cypher:
            m.result_set = [[2]]
        elif "max(t.id)" in cypher:
            m.result_set = [[3]]  # next task is 3
        elif "WHERE t.id IN $deps" in cypher:
            m.result_set = [[1], [2]]  # deps exist
        elif "RETURN a.id, b.id" in cypher:
            m.result_set = [[2, 3]]  # 2 depends on 3
        else:
            m.result_set = []
        return m

    mock_graph.query.side_effect = mock_query

    # If new task 3 depends on 2, but 2 already depends on 3 -> cycle!
    with pytest.raises(ValueError) as exc:
        create_task(mock_graph, {
            "name": "Circular Task",
            "owner": "Alice",
            "project": "Demo",
            "dependsOn": [2],
        })
    assert "Circular dependency" in str(exc.value)


def test_task_creation_200_cap_enforcement():
    """Enforces 200 task cap per workspace."""
    from app.graph import create_task

    mock_graph = MagicMock()
    mock_graph.query.return_value.result_set = [[200]]  # current count 200

    with pytest.raises(ValueError) as exc:
        create_task(mock_graph, {
            "name": "Over Limit Task",
            "owner": "Alice",
            "project": "Demo",
        })
    assert "limit reached" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_live_supabase_two_users_isolation():
    """
    Live Supabase integration test:
    Creates two test users via Supabase Auth API, verifies isolation, and deletes them afterwards.
    Only runs if live SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are configured in environment.
    """
    live_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    live_service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    live_anon_key = os.getenv("SUPABASE_ANON_KEY", "")

    if not live_url or not live_service_key or "mock-project" in live_url or "your-project" in live_url:
        pytest.skip("Live Supabase credentials not configured in environment")

    import httpx
    admin_headers = {
        "apikey": live_service_key,
        "Authorization": f"Bearer {live_service_key}",
        "Content-Type": "application/json",
    }

    user_a_id = None
    user_b_id = None
    user_a_email = f"test-a-{int(time.time())}@taskpilot-test.local"
    user_b_email = f"test-b-{int(time.time())}@taskpilot-test.local"
    test_password = "P@ssword12345!Secure"

    async with httpx.AsyncClient(timeout=15.0) as http:
        try:
            # Create user A
            r_a = await http.post(
                f"{live_url}/auth/v1/admin/users",
                headers=admin_headers,
                json={"email": user_a_email, "password": test_password, "email_confirm": True},
            )
            assert r_a.status_code in (200, 201), f"Failed to create user A: {r_a.text}"
            user_a_id = r_a.json()["id"]

            # Create user B
            r_b = await http.post(
                f"{live_url}/auth/v1/admin/users",
                headers=admin_headers,
                json={"email": user_b_email, "password": test_password, "email_confirm": True},
            )
            assert r_b.status_code in (200, 201), f"Failed to create user B: {r_b.text}"
            user_b_id = r_b.json()["id"]

            # Sign in user A
            token_a_res = await http.post(
                f"{live_url}/auth/v1/token?grant_type=password",
                headers={"apikey": live_anon_key, "Content-Type": "application/json"},
                json={"email": user_a_email, "password": test_password},
            )
            assert token_a_res.status_code == 200
            token_a = token_a_res.json()["access_token"]

            # Sign in user B
            token_b_res = await http.post(
                f"{live_url}/auth/v1/token?grant_type=password",
                headers={"apikey": live_anon_key, "Content-Type": "application/json"},
                json={"email": user_b_email, "password": test_password},
            )
            assert token_b_res.status_code == 200
            token_b = token_b_res.json()["access_token"]

            # User B creates a workspace
            with patch("app.main.SUPABASE_URL", live_url), \
                 patch("app.auth.SUPABASE_URL", live_url), \
                 patch("app.auth.SUPABASE_ANON_KEY", live_anon_key), \
                 patch("app.auth.SUPABASE_SERVICE_ROLE_KEY", live_service_key):

                ws_create = client.post(
                    "/api/workspaces",
                    headers={"Authorization": f"Bearer {token_b}"},
                    json={"name": "Live B Workspace"},
                )
                assert ws_create.status_code == 201
                ws_b_id = ws_create.json()["id"]

                # User A attempts to access User B's workspace -> must be 404
                access_attempt = client.get(
                    "/api/tasks",
                    headers={"Authorization": f"Bearer {token_a}", "X-Workspace": ws_b_id},
                )
                assert access_attempt.status_code == 404

                # Clean up workspace
                del_ws = client.delete(
                    f"/api/workspaces/{ws_b_id}",
                    headers={"Authorization": f"Bearer {token_b}"},
                )
                assert del_ws.status_code == 200

        finally:
            # Delete both test users from Supabase Auth API
            if user_a_id:
                await http.delete(f"{live_url}/auth/v1/admin/users/{user_a_id}", headers=admin_headers)
            if user_b_id:
                await http.delete(f"{live_url}/auth/v1/admin/users/{user_b_id}", headers=admin_headers)

