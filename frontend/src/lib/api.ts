export type Task = {
  id: number;
  name: string;
  owner: string;
  email: string;
  deadline: string;
  status: string;
  reminderSent: boolean;
  priority?: string;
};
export type Ranked = { taskId: number; name: string; owner: string; daysOverdue: number; blocksCount: number };
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
  nodes: { id: string; label: string; type: string }[];
  edges: { from: string; to: string; type: string }[];
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

export const API_BASE: string = (import.meta.env["VITE_API_BASE"] as string | undefined) ?? "";
export const IS_DEMO = !API_BASE;

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(`${API_BASE.replace(/\/$/, "")}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError")
      throw new ApiError("The backend took longer than 30 seconds to answer. Try again in a moment.");
    throw new ApiError("Could not reach the backend. Check that it is running and reachable.");
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
    throw new ApiError((body as { error: string }).error);
  }
  if (!res.ok) throw new ApiError(`The backend returned an error (HTTP ${res.status}).`);
  return body as T;
}

/* ---------- mock ---------- */
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
      id, name, owner, email: emails[owner] ?? "", deadline: isoOffset(off), status, reminderSent: false,
    }));
  }
  return mockTasks!;
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function draft(t: Task) {
  return `Hi ${t.owner}, this is a gentle reminder about "${t.name}", which was due on ${t.deadline}. Its status is "${t.status}". Could you share an update or a new estimated completion time? Thank you!`;
}

/* ---------- public API ---------- */
export async function getTasks(): Promise<Task[]> {
  if (IS_DEMO) {
    await sleep(400);
    return clone(store());
  }
  return request<Task[]>("/api/tasks");
}

export async function runAgent(instruction: string): Promise<AgentResponse> {
  if (IS_DEMO) {
    await sleep(1500);
    const tasks = store();
    const byId = (id: number) => tasks.find((t) => t.id === id)!;
    const overdue = [1, 3, 7].map(byId);
    const actions: Action[] = overdue.map((t) => ({
      id: `a${t.id}`, taskId: t.id, owner: t.owner, email: t.email, taskName: t.name,
      message: draft(t), status: "pending_approval", ...(t.id === 7 ? { cc: "Priya" } : {}),
    }));
    const trace = ["find_overdue_tasks({})"];
    for (const id of [3, 1, 7]) trace.push(`get_task_owner({"task_id":${id}})`, `draft_reminder({"task_id":${id}})`);
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
  return request<AgentResponse>("/api/agent", { method: "POST", body: JSON.stringify({ instruction }) });
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
  return request("/api/approve", { method: "POST", body: JSON.stringify({ actions }) });
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

/* ---------- helpers ---------- */
export function daysOverdue(deadline: string, status: string, today = new Date()): number {
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
    /* keep raw */
  }
  return { tool: m[1] ?? "", args: args || "{}" };
}
