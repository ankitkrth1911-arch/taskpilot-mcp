"""
Authentication and PostgREST Workspace Module for TaskPilot Backend.
Verifies Supabase JWTs with signature, expiration, issuer, audience, and algorithm allowlist.
Extracts verified identity (sub claim) and is_anonymous status.
Enforces that user id is NEVER accepted from body, query or custom headers.
Performs PostgREST operations under the user's JWT to enforce RLS.
"""

import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

import httpx
import jwt
from jwt import PyJWKClient
from fastapi import Request, HTTPException, status
from pydantic import BaseModel

logger = logging.getLogger("taskpilot.auth")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# Algorithm allowlist: reject "none" and untrusted algorithms
ALLOWED_ALGORITHMS = ["RS256", "ES256", "HS256"]

# Cached JWKS client for asymmetric keys
_jwks_client: Optional[PyJWKClient] = None


def get_jwks_client() -> Optional[PyJWKClient]:
    """Returns singleton cached PyJWKClient for Supabase JWKS endpoint."""
    global _jwks_client
    if _jwks_client is None and SUPABASE_URL:
        jwks_url = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"
        _jwks_client = PyJWKClient(jwks_url, cache_keys=True)
    return _jwks_client


class UserClaims(BaseModel):
    """Verified claims from a Supabase JWT."""
    sub: str
    email: Optional[str] = None
    is_anonymous: bool = False
    role: Optional[str] = None
    raw_token: str


def redact_token(token: Optional[str]) -> str:
    """Helper to redact sensitive token strings in logs."""
    if not token:
        return ""
    if len(token) <= 10:
        return "[REDACTED]"
    return f"{token[:4]}...[REDACTED]...{token[-4:]}"


def verify_supabase_jwt(token: str) -> UserClaims:
    """
    Cryptographically verifies the Supabase JWT:
    - Rejects algorithm 'none' and unexpected algorithms.
    - Verifies signature (JWKS for RS256/ES256, secret for HS256).
    - Verifies exp, iss (SUPABASE_URL/auth/v1), aud == 'authenticated'.
    - Returns UserClaims with verified sub and is_anonymous.
    """
    if not token or not token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or empty authentication token",
        )

    # 1. Inspect unverified header for algorithm checks
    try:
        header = jwt.get_unverified_header(token)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed token header",
        )

    alg = header.get("alg")
    if not alg or alg.lower() == "none" or alg not in ALLOWED_ALGORITHMS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Disallowed token algorithm: {alg}",
        )

    expected_issuer = f"{SUPABASE_URL}/auth/v1" if SUPABASE_URL else None
    expected_audience = "authenticated"

    # 2. Decode & verify signature according to algorithm
    payload: Dict[str, Any] = {}
    try:
        if alg in ("RS256", "ES256"):
            client = get_jwks_client()
            if not client:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="JWKS client unconfigured: missing SUPABASE_URL",
                )
            signing_key = client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=[alg],
                audience=expected_audience,
                issuer=expected_issuer,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
        else:
            # HS256 secret verification
            secret = SUPABASE_JWT_SECRET or SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY
            if not secret:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Server unconfigured: missing JWT secret",
                )
            payload = jwt.decode(
                token,
                secret,
                algorithms=["HS256"],
                audience=expected_audience,
                issuer=expected_issuer,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
        )
    except jwt.InvalidAudienceError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token audience",
        )
    except jwt.InvalidIssuerError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token issuer",
        )
    except jwt.InvalidSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token signature",
        )
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {str(e)}",
        )

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject claim",
        )

    # Read is_anonymous from claim
    is_anon = bool(payload.get("is_anonymous", False))

    return UserClaims(
        sub=str(sub),
        email=payload.get("email"),
        is_anonymous=is_anon,
        role=payload.get("role"),
        raw_token=token,
    )


def extract_bearer_token(request: Request) -> Optional[str]:
    """Extracts raw Bearer token from request Authorization header."""
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        return None
    parts = auth_header.strip().split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


async def get_current_user(request: Request) -> UserClaims:
    """Dependency: strictly requires authenticated Supabase user."""
    token = extract_bearer_token(request)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization Bearer header",
        )
    return verify_supabase_jwt(token)


async def get_optional_user(request: Request) -> Optional[UserClaims]:
    """Dependency: optional authentication (for public demo vs user workspace)."""
    token = extract_bearer_token(request)
    if not token:
        return None
    try:
        return verify_supabase_jwt(token)
    except HTTPException:
        # If token is explicitly malformed/invalid/expired, reject with 401
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
        )


def validate_workspace_id(workspace_id_str: str) -> str:
    """Validates that workspace ID is a valid UUID string to prevent injection."""
    try:
        parsed = uuid.UUID(str(workspace_id_str))
        return str(parsed)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid X-Workspace header: must be a valid UUID",
        )


# ==============================================================================
# PostgREST Workspace CRUD with User JWT (RLS Applied)
# ==============================================================================

async def postgrest_request(
    user_jwt: str,
    method: str,
    path: str,
    params: Optional[Dict[str, Any]] = None,
    json_data: Optional[Any] = None,
    prefer: Optional[str] = None,
) -> httpx.Response:
    """Executes a PostgREST call forwarding the user's JWT so RLS policies apply."""
    if not SUPABASE_URL:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Supabase URL not configured on server",
        )

    headers = {
        "apikey": SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {user_jwt}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer

    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        return await client.request(
            method=method,
            url=url,
            params=params,
            json=json_data,
            headers=headers,
        )


async def create_workspace_in_db(user_jwt: str, name: str) -> Dict[str, Any]:
    """
    Creates a workspace row in Supabase workspaces table with user's JWT.
    DB trigger sets graph_name, expiry (7 days for guests) and enforces plan limits.
    """
    resp = await postgrest_request(
        user_jwt=user_jwt,
        method="POST",
        path="workspaces",
        json_data={"name": name},
        prefer="return=representation",
    )
    if resp.status_code in (200, 201):
        data = resp.json()
        if isinstance(data, list) and len(data) > 0:
            return data[0]
        if isinstance(data, dict):
            return data
        return {"name": name}

    # Error handling from PostgREST/RLS/trigger
    err_msg = resp.text
    try:
        err_json = resp.json()
        err_msg = err_json.get("message") or err_json.get("error") or err_msg
    except Exception:
        pass

    if resp.status_code in (400, 403, 409, 422):
        raise HTTPException(status_code=resp.status_code, detail=err_msg)
    raise HTTPException(status_code=500, detail=f"Database error creating workspace: {err_msg}")


async def list_workspaces_for_user(user_jwt: str) -> List[Dict[str, Any]]:
    """Lists workspaces accessible to the user via PostgREST and RLS."""
    resp = await postgrest_request(
        user_jwt=user_jwt,
        method="GET",
        path="workspaces",
        params={"select": "*", "order": "created_at.desc"},
    )
    if resp.status_code == 200:
        return resp.json()
    err_msg = resp.text
    try:
        err_msg = resp.json().get("message", err_msg)
    except Exception:
        pass
    raise HTTPException(status_code=resp.status_code, detail=f"Database error listing workspaces: {err_msg}")


async def get_workspace_for_user(user_jwt: str, workspace_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetches a single workspace by UUID with user's JWT.
    If RLS hides it or it doesn't exist, returns None (never reveal existence).
    """
    valid_id = validate_workspace_id(workspace_id)
    resp = await postgrest_request(
        user_jwt=user_jwt,
        method="GET",
        path="workspaces",
        params={"id": f"eq.{valid_id}", "select": "*"},
    )
    if resp.status_code == 200:
        rows = resp.json()
        if isinstance(rows, list) and len(rows) > 0:
            return rows[0]
        return None
    return None


async def update_workspace_last_used(user_jwt: str, workspace_id: str) -> None:
    """Updates last_used_at on the workspace row via user JWT."""
    valid_id = validate_workspace_id(workspace_id)
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        await postgrest_request(
            user_jwt=user_jwt,
            method="PATCH",
            path="workspaces",
            params={"id": f"eq.{valid_id}"},
            json_data={"last_used_at": now_iso},
            prefer="return=minimal",
        )
    except Exception as e:
        logger.warning(f"Could not update last_used_at for workspace {valid_id}: {e}")


async def delete_workspace_in_db(user_jwt: str, workspace_id: str) -> bool:
    """Deletes workspace row via PostgREST with user's JWT."""
    valid_id = validate_workspace_id(workspace_id)
    resp = await postgrest_request(
        user_jwt=user_jwt,
        method="DELETE",
        path="workspaces",
        params={"id": f"eq.{valid_id}"},
        prefer="return=representation",
    )
    if resp.status_code in (200, 204):
        return True
    return False
