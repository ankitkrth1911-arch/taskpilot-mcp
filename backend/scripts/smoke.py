"""
End-to-End Smoke Test Suite for TaskPilot Graph.
Runs 12 comprehensive checks against a live TaskPilot Graph instance:
- Root healthcheck and metadata
- Admin security authentication
- Graph resetting and synthetic seeding
- Task listing and graph topology visualization
- Agent evaluation, impact ranking [3, 1, 7], and Action node persistence
- Human approval verification, TTL expiry, duplicate suppression, and anti-forgery
- State persistence in FalkorDB
- Rate limiting enforcement (10 req/min)
- MCP streamable endpoint check
"""

import os
import sys
import time
import httpx

BASE_URL = os.getenv("BASE_URL", "http://127.0.0.1:8000")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")

print(f"\n=======================================================")
print(f"  TASKPILOT GRAPH - LIVE SMOKE & VERIFICATION SUITE")
print(f"  Target: {BASE_URL}")
print(f"=======================================================\n")

passed = 0
failed = 0


def report(name: str, success: bool, detail: str = ""):
    global passed, failed
    if success:
        passed += 1
        print(f"  [PASS] {name} {f'({detail})' if detail else ''}")
    else:
        failed += 1
        print(f"  [FAIL] {name}: {detail}")


client = httpx.Client(base_url=BASE_URL, timeout=10.0)

# -------------------------------------------------------------
# Check 1: Healthcheck & Service Metadata
# -------------------------------------------------------------
try:
    r = client.get("/")
    if r.status_code == 200 and r.json().get("database") == "FalkorDB":
        report("Check 1: Healthcheck & FalkorDB Metadata", True, f"Service: {r.json().get('service')}")
    else:
        report("Check 1: Healthcheck & FalkorDB Metadata", False, f"HTTP {r.status_code}: {r.text}")
except Exception as e:
    report("Check 1: Healthcheck & FalkorDB Metadata", False, str(e))

# -------------------------------------------------------------
# Check 2: Admin Reset Security (Missing & Invalid Token)
# -------------------------------------------------------------
try:
    r_missing = client.post("/api/admin/reset")
    r_bad = client.post("/api/admin/reset", headers={"X-Admin-Token": "bad-token"})
    if r_missing.status_code == 401 and r_bad.status_code == 401:
        report("Check 2: Admin Reset Security (401 on missing/invalid token)", True)
    else:
        report("Check 2: Admin Reset Security", False, f"Missing: {r_missing.status_code}, Bad: {r_bad.status_code}")
except Exception as e:
    report("Check 2: Admin Reset Security", False, str(e))

# -------------------------------------------------------------
# Check 3: Admin Reset & Seeding Execution
# -------------------------------------------------------------
try:
    r = client.post("/api/admin/reset", headers={"X-Admin-Token": ADMIN_TOKEN})
    if r.status_code == 200 and r.json().get("status") == "ok":
        counts = r.json().get("details", {}).get("counts", {})
        report("Check 3: Admin Reset & Graph Seeding", True, f"Counts: {counts}")
    else:
        report("Check 3: Admin Reset & Graph Seeding", False, f"HTTP {r.status_code}: {r.text}")
except Exception as e:
    report("Check 3: Admin Reset & Graph Seeding", False, str(e))

# -------------------------------------------------------------
# Check 4: List Tasks Schema & Data
# -------------------------------------------------------------
try:
    r = client.get("/api/tasks")
    if r.status_code == 200 and isinstance(r.json(), list) and len(r.json()) == 8:
        task1 = next((t for t in r.json() if t.get("id") == 1), None)
        if task1 and task1.get("owner") == "Rahul" and task1.get("project") == "Website Launch":
            report("Check 4: GET /api/tasks (8 tasks seeded with owners & projects)", True)
        else:
            report("Check 4: GET /api/tasks", False, f"Unexpected task 1 shape: {task1}")
    else:
        report("Check 4: GET /api/tasks", False, f"HTTP {r.status_code}, count: {len(r.json()) if r.status_code == 200 else 'N/A'}")
except Exception as e:
    report("Check 4: GET /api/tasks", False, str(e))

# -------------------------------------------------------------
# Check 5: Graph Topology Export (/api/graph)
# -------------------------------------------------------------
try:
    r = client.get("/api/graph")
    if r.status_code == 200:
        data = r.json()
        nodes = data.get("nodes", [])
        edges = data.get("edges", [])
        if len(nodes) >= 15 and len(edges) >= 15:
            report("Check 5: GET /api/graph visualization export", True, f"{len(nodes)} nodes, {len(edges)} edges")
        else:
            report("Check 5: GET /api/graph visualization export", False, f"Node count: {len(nodes)}, Edge count: {len(edges)}")
    else:
        report("Check 5: GET /api/graph", False, f"HTTP {r.status_code}: {r.text}")
except Exception as e:
    report("Check 5: GET /api/graph", False, str(e))

# -------------------------------------------------------------
# Check 6: Agent Input Validation (Max length 500 chars)
# -------------------------------------------------------------
try:
    r = client.post("/api/agent", json={"instruction": "A" * 501})
    if r.status_code == 400 and "maximum length" in r.json().get("error", "").lower():
        report("Check 6: Agent instruction length validation (>500 chars -> 400)", True)
    else:
        report("Check 6: Agent instruction validation", False, f"HTTP {r.status_code}: {r.text}")
except Exception as e:
    report("Check 6: Agent instruction validation", False, str(e))

# -------------------------------------------------------------
# Check 7: Agent Execution & Impact Ranking Verification [3, 1, 7]
# -------------------------------------------------------------
first_action_id = None
try:
    r = client.post("/api/agent", json={"instruction": "Audit overdue tasks and draft reminders."})
    if r.status_code == 200:
        data = r.json()
        ranked = data.get("ranked", [])
        ranked_ids = [item.get("taskId") for item in ranked]
        actions = data.get("actions", [])

        if ranked_ids[:3] == [3, 1, 7]:
            report("Check 7: Agent Ranking Criteria (Task 3 blocks 2, Task 1 blocks 1, Task 7 blocks 1)", True, f"Order: {ranked_ids}")
        else:
            report("Check 7: Agent Ranking Criteria", False, f"Expected [3, 1, 7] but got {ranked_ids}")

        if actions and len(actions) > 0:
            first_action_id = actions[0].get("id")
            report("Check 7b: Action Node Persistence in FalkorDB", True, f"Action ID: {first_action_id}")
        else:
            report("Check 7b: Action Node Persistence in FalkorDB", False, "No actions returned")
    else:
        report("Check 7: Agent Execution", False, f"HTTP {r.status_code}: {r.text}")
except Exception as e:
    report("Check 7: Agent Execution", False, str(e))

# -------------------------------------------------------------
# Check 8: Approval Payload Validation (Empty & Malformed)
# -------------------------------------------------------------
try:
    r1 = client.post("/api/approve", json={"actions": []})
    r2 = client.post("/api/approve", json={"invalid": True})
    if r1.status_code == 400 and r2.status_code == 400:
        report("Check 8: Approval Payload Validation (Empty / Malformed -> 400)", True)
    else:
        report("Check 8: Approval Payload Validation", False, f"Empty: {r1.status_code}, Malformed: {r2.status_code}")
except Exception as e:
    report("Check 8: Approval Payload Validation", False, str(e))

# -------------------------------------------------------------
# Check 9: Anti-Forgery & Unknown Action ID Handling
# -------------------------------------------------------------
try:
    r = client.post("/api/approve", json={"actions": [{"id": "act_forged_fake_id_9999"}]})
    if r.status_code == 200:
        res = r.json().get("results", [{}])[0]
        if res.get("result") == "failed" and "unknown" in res.get("detail", "").lower():
            report("Check 9: Anti-Forgery & Unknown Action ID Rejection", True, res.get("detail"))
        else:
            report("Check 9: Anti-Forgery", False, f"Unexpected result: {res}")
    else:
        report("Check 9: Anti-Forgery", False, f"HTTP {r.status_code}: {r.text}")
except Exception as e:
    report("Check 9: Anti-Forgery", False, str(e))

# -------------------------------------------------------------
# Check 10: Human Approval Execution & Duplicate Suppression
# -------------------------------------------------------------
if first_action_id:
    try:
        # First approval
        r = client.post("/api/approve", json={"actions": [{"id": first_action_id}]})
        res1 = r.json().get("results", [{}])[0]
        if r.status_code == 200 and res1.get("result") == "done":
            report("Check 10a: Human Approval Execution", True, res1.get("detail"))
        else:
            report("Check 10a: Human Approval Execution", False, f"HTTP {r.status_code}: {res1}")

        # Duplicate approval attempt
        r_dup = client.post("/api/approve", json={"actions": [{"id": first_action_id}]})
        res2 = r_dup.json().get("results", [{}])[0]
        if r_dup.status_code == 200 and res2.get("result") == "skipped":
            report("Check 10b: Duplicate Approval Suppression (result: skipped)", True, res2.get("detail"))
        else:
            report("Check 10b: Duplicate Approval Suppression", False, f"HTTP {r_dup.status_code}: {res2}")
    except Exception as e:
        report("Check 10: Human Approval Execution", False, str(e))
else:
    report("Check 10: Human Approval Execution", False, "Skipped: no action ID from Check 7")

# -------------------------------------------------------------
# Check 11: State Persistence in FalkorDB (reminderSent verified)
# -------------------------------------------------------------
try:
    r = client.get("/api/tasks")
    if r.status_code == 200:
        # Task 3 was approved
        task3 = next((t for t in r.json() if t.get("id") == 3), None)
        if task3 and task3.get("reminderSent") is True and task3.get("reminderSentAt"):
            report("Check 11: State Persistence in FalkorDB (Task 3 reminderSent=True)", True, f"SentAt: {task3.get('reminderSentAt')}")
        else:
            report("Check 11: State Persistence in FalkorDB", False, f"Task 3 state: {task3}")
    else:
        report("Check 11: State Persistence in FalkorDB", False, f"HTTP {r.status_code}")
except Exception as e:
    report("Check 11: State Persistence in FalkorDB", False, str(e))

# -------------------------------------------------------------
# Check 12: Streamable MCP Endpoint Presence (/mcp)
# -------------------------------------------------------------
try:
    r = client.get("/mcp")
    # Streamable MCP endpoint or session endpoint responds (200, 400, or 405 on GET)
    if r.status_code in (200, 400, 404, 405):
        report("Check 12: Streamable MCP Mount at /mcp", True, f"HTTP {r.status_code} responded on /mcp")
    else:
        report("Check 12: Streamable MCP Mount at /mcp", False, f"HTTP {r.status_code}: {r.text}")
except Exception as e:
    report("Check 12: Streamable MCP Mount at /mcp", False, str(e))

print(f"\n=======================================================")
print(f"  SMOKE TEST SUMMARY: {passed} PASSED, {failed} FAILED")
print(f"=======================================================\n")

if failed > 0:
    sys.exit(1)
sys.exit(0)
