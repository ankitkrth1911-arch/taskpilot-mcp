import { supabase } from "./supabase";

export type Task = {
  id: number;
  name: string;
  owner: string;
  email: string;
  manager?: string;
  project: string;
  deadline?: string | null;
  status: string;
  reminderSent: boolean;
  priority?: string;
  dependsOn?: number[];
};

export type Ranked = {
  taskId: number;
  name: string;
  owner: string;
  daysOverdue: number;
  blocksCount: number;
};

export type Action = {
  id: string;
  taskId: number;
  owner: string;
  email: string;
  taskName: string;
  message: string;
  status: "pending_approval";
  cc?: string;
};

export type Graph = {
  nodes: { id: string; label: string; type?: string; properties?: Record<string, unknown> }[];
  edges: { source?: string; target?: string; from?: string; to?: string; type?: string; properties?: Record<string, unknown> }[];
};

export type AgentResponse = {
  mode: "llm" | "deterministic";
  overdue: Task[];
  actions: Action[];
  trace: string[];
  summary: string;
  ranked?: Ranked[];
  reasoning?: string[];
};

export type ApproveResult = { id: string; result: "done" | "failed" | "skipped"; detail: string };

export type Workspace = {
  id: string;
  name: string;
  graph_name?: string;
  created_at?: string;
  expires_at?: string;
  last_used_at?: string;
};

export type TaskCreateInput = {
  name: string;
  owner: string;
  ownerEmail?: string;
  manager?: string;
  project: string;
  deadline?: string;
  status?: string;
  dependsOn?: number[];
};

export const API_BASE: string = (import.meta.env["VITE_API_BASE"] as string | undefined)?.replace(/\/$/, "") ?? "";
export const IS_DEMO = !API_BASE;

export class ApiError extends Error {}

const WORKSPACE_STORAGE_KEY = "taskpilot_active_workspace";

export function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const ws = JSON.parse(raw);
    return ws?.id || null;
  } catch {
    return null;
  }
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      headers["Authorization"] = `Bearer ${session.access_token}`;
    }
  } catch {
    // Session retrieval error ignored
  }

  const workspaceId = getActiveWorkspaceId();
  if (workspaceId) {
    headers["X-Workspace"] = workspaceId;
  }

  return headers;
}

async function request<T>(path: string, init?: RequestInit, isRetry = false): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  const defaultHeaders = await getAuthHeaders();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { ...defaultHeaders, ...(init?.headers ?? {}) },
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") {
      throw new ApiError("The backend took longer than 30 seconds to answer. Try again in a moment.");
    }
    throw new ApiError("Could not reach the backend. Check that it is running and reachable.");
  } finally {
    clearTimeout(timer);
  }

  // On 401: attempt token refresh once if authenticated
  if (res.status === 401 && !isRetry && defaultHeaders["Authorization"]) {
    try {
      const { data: { session: refreshedSession }, error: refreshErr } = await supabase.auth.refreshSession();
      if (!refreshErr && refreshedSession?.access_token) {
        // Retry request once with new token
        return request<T>(path, init, true);
      } else {
        // Refresh failed: sign out cleanly
        await supabase.auth.signOut();
        if (typeof window !== "undefined") {
          window.location.href = "/login";
        }
      }
    } catch {
      await supabase.auth.signOut();
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
    }
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response
  }

  if (body && typeof body === "object") {
    if ("error" in body && typeof (body as { error: unknown }).error === "string") {
      throw new ApiError((body as { error: string }).error);
    }
    if ("detail" in body && typeof (body as { detail: unknown }).detail === "string") {
      throw new ApiError((body as { detail: string }).detail);
    }
  }

  if (!res.ok) {
    throw new ApiError(`The backend returned an error (HTTP ${res.status}).`);
  }

  return body as T;
}

/* ---------- mock store for standalone frontend demo mode ---------- */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function isoOffset(days: number, base = new Date()) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
const emails: Record<string, string> = {
  Rahul: "rahul@example.com",
  Priya: "priya@example.com",
  Aman: "aman@example.com",
  Neha: "neha@example.com",
};
let mockTasks: Task[] | null = null;
function store(): Task[] {
  if (!mockTasks) {
    const rows: [number, string, string, number, string][] = [
      [1, "Complete project documentation", "Rahul", -1, "Pending"],
      [2, "Finish frontend", "Priya", 1, "In progress"],
      [3, "Test backend", "Aman", -2, "Pending"],
      [4, "Prepare demo video", "Priya", -3, "Done"],
      [5, "Write README", "Rahul", 3, "Pending"],
      [6, "Set up CI pipeline", "Neha", 2, "In progress"],
      [7, "Deploy staging environment", "Neha", -4, "Pending"],
    ];
    mockTasks = rows.map(([id, name, owner, off, status]) => ({
      id,
      name,
      owner,
      email: emails[owner] ?? "",
      project: "Website Launch",
      deadline: isoOffset(off),
      status,
      reminderSent: false,
    }));
  }
  return mockTasks;
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function draft(t: Task) {
  return `Hi ${t.owner}, this is a gentle reminder about "${t.name}", which was due on ${t.deadline}. Its status is "${t.status}". Could you share an update or a new estimated completion time? Thank you!`;
}

/* ---------- Public and Authenticated API Functions ---------- */

export async function getTasks(): Promise<Task[]> {
  if (IS_DEMO) {
    await sleep(400);
    return clone(store());
  }
  return request<Task[]>("/api/tasks");
}

export async function createTask(task: TaskCreateInput): Promise<Task> {
  if (IS_DEMO) {
    await sleep(300);
    const tasks = store();
    const newId = tasks.length ? Math.max(...tasks.map((t) => t.id)) + 1 : 1;
    const newTask: Task = {
      id: newId,
      name: task.name,
      owner: task.owner,
      email: task.ownerEmail || "",
      manager: task.manager || "",
      project: task.project,
      deadline: task.deadline || null,
      status: task.status || "Pending",
      reminderSent: false,
      dependsOn: task.dependsOn || [],
    };
    tasks.push(newTask);
    return clone(newTask);
  }
  return request<Task>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(task),
  });
}

export async function deleteTask(id: number): Promise<void> {
  if (IS_DEMO) {
    await sleep(300);
    mockTasks = store().filter((t) => t.id !== id);
    return;
  }
  await request<{ status: string; message: string }>(`/api/tasks/${id}`, {
    method: "DELETE",
  });
}

export async function runAgent(instruction: string): Promise<AgentResponse> {
  if (IS_DEMO) {
    await sleep(1500);
    const tasks = store();
    const byId = (id: number) => tasks.find((t) => t.id === id)!;
    const overdue = [1, 3, 7].map(byId).filter(Boolean);
    const actions: Action[] = overdue.map((t) => ({
      id: `a${t.id}`,
      taskId: t.id,
      owner: t.owner,
      email: t.email,
      taskName: t.name,
      message: draft(t),
      status: "pending_approval",
      ...(t.id === 7 ? { cc: "Priya" } : {}),
    }));
    const trace = ["find_overdue_tasks({})"];
    for (const id of [3, 1, 7]) {
      trace.push(`get_task_owner({"task_id":${id}})`, `draft_reminder({"task_id":${id}})`);
    }
    return clone({
      mode: "deterministic",
      overdue,
      actions,
      trace,
      summary: `3 tasks are past deadline. I drafted a reminder for each owner. Test backend should be chased first because it blocks 3 other tasks. Nothing is sent until you approve.`,
      ranked: [
        { taskId: 3, name: "Test backend", owner: "Aman", daysOverdue: 2, blocksCount: 3 },
        { taskId: 1, name: "Complete project documentation", owner: "Rahul", daysOverdue: 1, blocksCount: 2 },
        { taskId: 7, name: "Deploy staging environment", owner: "Neha", daysOverdue: 4, blocksCount: 1 },
      ],
      reasoning: [
        "Test backend → blocks → Finish frontend → blocks → Prepare demo video",
        "Test backend → blocks → Deploy staging environment",
        "Complete project documentation → blocks → Write README → blocks → Prepare demo video",
        "Deploy staging environment → blocks → Prepare demo video",
      ],
    } satisfies AgentResponse);
  }
  return request<AgentResponse>("/api/agent", {
    method: "POST",
    body: JSON.stringify({ instruction }),
  });
}

export async function approveActions(actions: Action[]): Promise<{ results: ApproveResult[] }> {
  if (IS_DEMO) {
    await sleep(800);
    const tasks = store();
    return {
      results: actions.map((a) => {
        const t = tasks.find((x) => x.id === a.taskId);
        if (!t) return { id: a.id, result: "failed", detail: `Task ${a.taskId} not found` };
        if (t.reminderSent) return { id: a.id, result: "skipped", detail: "Reminder already recorded" };
        t.reminderSent = true;
        return { id: a.id, result: "done", detail: `Reminder to ${a.owner} recorded (simulated send)` };
      }),
    };
  }
  return request("/api/approve", {
    method: "POST",
    body: JSON.stringify({ actions }),
  });
}

export async function getGraph(): Promise<Graph> {
  if (IS_DEMO) {
    await sleep(300);
    const t = store();
    const people = ["Rahul", "Priya", "Aman", "Neha"];
    return {
      nodes: [
        ...people.map((p) => ({ id: `p:${p}`, label: p, type: "person" })),
        ...t.map((x) => ({ id: `t:${x.id}`, label: x.name, type: "task" })),
        { id: "proj:1", label: "TaskPilot launch", type: "project" },
      ],
      edges: [
        ...t.map((x) => ({ from: `p:${x.owner}`, to: `t:${x.id}`, type: "owns" })),
        ...t.map((x) => ({ from: `t:${x.id}`, to: "proj:1", type: "belongs_to" })),
        { from: "t:3", to: "t:2", type: "blocks" },
        { from: "t:2", to: "t:4", type: "blocks" },
        { from: "t:3", to: "t:7", type: "blocks" },
        { from: "t:1", to: "t:5", type: "blocks" },
        { from: "t:7", to: "t:4", type: "blocks" },
      ],
    };
  }
  return request<Graph>("/api/graph");
}

/* ---------- Workspace Management API ---------- */

export async function getWorkspaces(): Promise<Workspace[]> {
  if (IS_DEMO) {
    return [{ id: "demo-ws", name: "Demo Workspace" }];
  }
  return request<Workspace[]>("/api/workspaces");
}

export async function createWorkspace(name: string): Promise<Workspace> {
  if (IS_DEMO) {
    return { id: `ws-${Date.now()}`, name };
  }
  return request<Workspace>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  if (IS_DEMO) {
    return;
  }
  await request<{ status: string; message: string }>(`/api/workspaces/${id}`, {
    method: "DELETE",
  });
}

/* ---------- helpers ---------- */

export function daysOverdue(deadline: string | null | undefined, status: string, today = new Date()): number {
  if (!deadline) return 0;
  if (status.toLowerCase() === "done") return 0;
  const [y, m, d] = deadline.split("-").map(Number);
  if (!y || !m || !d) return 0;
  const due = new Date(y, m - 1, d).getTime();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.max(0, Math.round((t0 - due) / 86_400_000));
}

export function parseTrace(entry: string): { tool: string; args: string } | null {
  const m = /^\s*([a-zA-Z_][\w.]*)\s*\(([\s\S]*)\)\s*$/.exec(entry);
  if (!m) return null;
  let args = (m[2] ?? "").trim();
  try {
    if (args) args = JSON.stringify(JSON.parse(args));
  } catch {
    // Keep raw string
  }
  return { tool: m[1] ?? "", args: args || "{}" };
}

/* ---------- billing & plans ---------- */

export type PlanLimits = {
  id: string;
  name: string;
  amount: number;
  currency: string;
  daily_agent_runs: number;
  daily_ai_runs: number;
  max_tasks_per_workspace: number;
  github_import_allowed: boolean;
  max_workspaces: number;
};

export type UsageToday = {
  agent_runs: number;
  ai_runs: number;
};

export type BillingMeResponse = {
  plan_id: string;
  plan: PlanLimits;
  limits: PlanLimits;
  usage_today: UsageToday;
};

export async function getBillingMe(): Promise<BillingMeResponse> {
  if (IS_DEMO) {
    return {
      plan_id: "free",
      plan: {
        id: "free",
        name: "Free",
        amount: 0,
        currency: "INR",
        daily_agent_runs: 10,
        daily_ai_runs: 5,
        max_tasks_per_workspace: 50,
        github_import_allowed: false,
        max_workspaces: 1,
      },
      limits: {
        id: "free",
        name: "Free",
        amount: 0,
        currency: "INR",
        daily_agent_runs: 10,
        daily_ai_runs: 5,
        max_tasks_per_workspace: 50,
        github_import_allowed: false,
        max_workspaces: 1,
      },
      usage_today: {
        agent_runs: 0,
        ai_runs: 0,
      },
    };
  }
  return request<BillingMeResponse>("/api/billing/me");
}

