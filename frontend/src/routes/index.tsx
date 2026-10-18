import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity, AlertTriangle, Bell, Bot, Check, CheckCircle2, Database, History, LayoutGrid, Loader2,
  LogIn, LogOut, Menu, Minus, Moon, Search, ShieldCheck, Sparkles, Sun, Terminal, User, UserCheck, X, XCircle, BarChart3,
  FolderPlus, Plus, Trash2, CreditCard,
} from "lucide-react";
import {
  approveActions, daysOverdue, getGraph, getTasks, IS_DEMO, parseTrace, runAgent,
  createWorkspace, deleteWorkspace, createTask, deleteTask,
  type Action, type ApproveResult, type Graph, type Ranked, type Task, type Workspace,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { DependencyGraph } from "@/components/taskpilot/DependencyGraph";
import { StatusChart, OverdueChart } from "@/components/taskpilot/Charts";
import { PricingModal } from "@/components/taskpilot/PricingModal";
import { ChatbotWidget } from "@/chatbot/ChatbotModal";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TaskPilot AI" },
      { name: "description", content: "AI agent that finds overdue work, reasons over a project graph, and drafts reminders for your approval." },
      { property: "og:title", content: "TaskPilot AI" },
      { property: "og:description", content: "AI agent that finds overdue work, reasons over a project graph, and drafts reminders for your approval." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TaskPilot,
});

/* ---------------- types & state ---------------- */
type AgentStatus = "Idle" | "Working" | "Awaiting your approval" | "Executing" | "Verifying" | "Done" | "Error";
type SourceState = { status: "loading" | "connected" | "unreachable" | "sample"; checkedAt?: Date; count?: number };
type Verification = "verified" | "not_verified" | "unavailable" | "n/a";
type ResultRow = ApproveResult & { taskId: number; taskName: string; notApproved?: boolean };
type HistoryRow = {
  key: string; time: Date; request: string; tools: string[]; taskName: string; proposed: string;
  approval: "Pending Approval" | "Approved" | "Skipped"; result?: "Completed" | "Failed" | "Skipped" | undefined; error?: string | undefined;
  actionId: string; runId: number;
};
type Run = { id: number; instruction: string; summary: string; mode: "llm" | "deterministic"; trace: string[]; time: Date };
type State = {
  tasks: Task[] | null; overdueIds: number[]; ranked: Ranked[]; reasoning: string[]; actions: Action[];
  selectedIds: string[]; mode: "llm" | "deterministic" | null; trace: string[]; summary: string;
  agentStatus: AgentStatus; running: boolean; approving: boolean; results: ResultRow[];
  verification: Record<string, Verification>; history: HistoryRow[]; runs: Run[];
  sources: { tasks: SourceState; graph: SourceState }; graph: Graph | null; graphError: string | null;
  error: string | null; ranOnce: boolean; approvedOnce: boolean; verified: boolean;
};
const initial: State = {
  tasks: null, overdueIds: [], ranked: [], reasoning: [], actions: [], selectedIds: [], mode: null, trace: [],
  summary: "", agentStatus: "Idle", running: false, approving: false, results: [], verification: {}, history: [],
  runs: [], sources: { tasks: { status: "loading" }, graph: { status: "loading" } }, graph: null, graphError: null,
  error: null, ranOnce: false, approvedOnce: false, verified: false,
};

const NAV = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "data", label: "Connected Data", icon: Database },
  { id: "agent", label: "AI Agent", icon: Bot },
  { id: "tools", label: "Tool Activity", icon: Terminal },
  { id: "approvals", label: "Action Approvals", icon: ShieldCheck },
  { id: "history", label: "Execution History", icon: History },
  { id: "insights", label: "Results & Insights", icon: BarChart3 },
];
const EXAMPLES = [
  "Find overdue tasks and prepare reminders",
  "Show me everything that is overdue",
  "Draft reminders only for overdue tasks",
];
const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");
const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const toolsOf = (trace: string[]) => [...new Set(trace.map((t) => parseTrace(t)?.tool).filter(Boolean) as string[])];

/* ---------------- page ---------------- */
function TaskPilot() {
  const {
    user,
    isGuest,
    isDemo,
    loading,
    currentWorkspace,
    workspaces,
    guestBannerDismissed,
    signOut,
    upgradeGuest,
    setCurrentWorkspace,
    refreshWorkspaces,
    dismissGuestBanner,
  } = useAuth();
  const navigate = useNavigate();
  const [s, setS] = useState<State>(initial);
  const patch = useCallback((p: Partial<State> | ((s: State) => Partial<State>)) =>
    setS((prev) => ({ ...prev, ...(typeof p === "function" ? p(prev) : p) })), []);
  const [query, setQuery] = useState("");
  const [instruction, setInstruction] = useState("Find overdue tasks and prepare reminders.");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  // Modal states
  const [pricingOpen, setPricingOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeEmail, setUpgradeEmail] = useState("");
  const [upgradePassword, setUpgradePassword] = useState("");
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const [deleteWorkspaceOpen, setDeleteWorkspaceOpen] = useState(false);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);

  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskForm, setTaskForm] = useState({
    name: "",
    owner: "",
    ownerEmail: "",
    manager: "",
    project: "Core",
    deadline: "",
    status: "Not Started",
    dependsOn: [] as number[],
  });

  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);

  useEffect(() => {
    if (!loading && !user && !isDemo) {
      navigate({ to: "/login" });
    }
  }, [loading, user, isDemo, navigate]);

  const loadData = useCallback(() => {
    patch((p) => ({
      sources: {
        tasks: { ...p.sources.tasks, status: "loading" },
        graph: { ...p.sources.graph, status: "loading" },
      },
    }));
    getTasks()
      .then((tasks) =>
        patch((p) => ({
          tasks,
          sources: {
            ...p.sources,
            tasks: {
              status: IS_DEMO || !currentWorkspace ? "sample" : "connected",
              checkedAt: new Date(),
              count: tasks.length,
            },
          },
        }))
      )
      .catch((e) =>
        patch((p) => ({
          tasks: [],
          error: errMsg(e),
          sources: { ...p.sources, tasks: { status: "unreachable", checkedAt: new Date() } },
        }))
      );
    getGraph()
      .then((graph) =>
        patch((p) => ({
          graph,
          sources: {
            ...p.sources,
            graph: {
              status: IS_DEMO || !currentWorkspace ? "sample" : "connected",
              checkedAt: new Date(),
              count: graph.nodes.length,
            },
          },
        }))
      )
      .catch((e) =>
        patch((p) => ({
          graphError: errMsg(e),
          sources: { ...p.sources, graph: { status: "unreachable", checkedAt: new Date() } },
        }))
      );
  }, [patch, currentWorkspace]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleUpgrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!upgradeEmail.trim() || !upgradePassword) {
      setUpgradeError("Please provide an email and password.");
      return;
    }
    setUpgradeError(null);
    setUpgrading(true);
    try {
      const res = await upgradeGuest(upgradeEmail.trim(), upgradePassword);
      if (res.success) {
        toast.success("Account upgraded successfully!", {
          description: "Your guest session is now a permanent account with preserved workspaces.",
        });
        setUpgradeOpen(false);
        setUpgradeEmail("");
        setUpgradePassword("");
      } else {
        setUpgradeError(res.error || "Failed to upgrade account.");
      }
    } catch (err) {
      setUpgradeError(errMsg(err));
    } finally {
      setUpgrading(false);
    }
  };

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newWorkspaceName.trim();
    if (!name) return;
    setCreatingWorkspace(true);
    setWorkspaceError(null);
    try {
      const newWs = await createWorkspace(name);
      await refreshWorkspaces();
      setCurrentWorkspace(newWs);
      toast.success(`Workspace "${newWs.name}" created`);
      setNewWorkspaceOpen(false);
      setNewWorkspaceName("");
    } catch (err) {
      setWorkspaceError(errMsg(err));
    } finally {
      setCreatingWorkspace(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    if (!currentWorkspace) return;
    setDeletingWorkspace(true);
    try {
      await deleteWorkspace(currentWorkspace.id);
      toast.success(`Workspace "${currentWorkspace.name}" deleted`);
      setCurrentWorkspace(null);
      await refreshWorkspaces();
      setDeleteWorkspaceOpen(false);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setDeletingWorkspace(false);
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskForm.name.trim() || !taskForm.owner.trim() || !taskForm.project.trim()) {
      setTaskError("Name, owner, and project are required.");
      return;
    }
    setCreatingTask(true);
    setTaskError(null);
    try {
      await createTask({
        name: taskForm.name.trim(),
        owner: taskForm.owner.trim(),
        ownerEmail: taskForm.ownerEmail.trim() || undefined,
        manager: taskForm.manager.trim() || undefined,
        project: taskForm.project.trim(),
        deadline: taskForm.deadline || undefined,
        status: taskForm.status,
        dependsOn: taskForm.dependsOn.length > 0 ? taskForm.dependsOn : undefined,
      });
      toast.success(`Task "${taskForm.name.trim()}" created`);
      setNewTaskOpen(false);
      setTaskForm({
        name: "",
        owner: "",
        ownerEmail: "",
        manager: "",
        project: "Core",
        deadline: "",
        status: "Not Started",
        dependsOn: [],
      });
      loadData();
    } catch (err) {
      setTaskError(errMsg(err));
    } finally {
      setCreatingTask(false);
    }
  };

  const handleDeleteTask = async (taskId: number) => {
    try {
      await deleteTask(taskId);
      toast.success("Task deleted");
      loadData();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out successfully");
    navigate({ to: "/login" });
  };

  const doRun = async (raw: string) => {
    const text = raw.trim().slice(0, 500);
    if (!text) { patch({ error: "Type an instruction for the agent first." }); return; }
    if (s.running || s.approving) return;
    patch({ running: true, agentStatus: "Working", error: null, actions: [], selectedIds: [], results: [], reasoning: [], ranked: [], verification: {}, verified: false, ranOnce: true, approvedOnce: false, trace: [], summary: "", overdueIds: [] });
    try {
      const r = await runAgent(text);
      const actions = Array.isArray(r.actions) ? r.actions : [];
      const trace = Array.isArray(r.trace) ? r.trace : [];
      const time = new Date();
      patch((p) => {
        const runId = p.runs.length + 1;
        const tools = toolsOf(trace);
        return {
          running: false, mode: r.mode, trace, summary: r.summary ?? "", actions,
          selectedIds: actions.map((a) => a.id),
          overdueIds: (r.overdue ?? []).map((t) => t.id),
          ranked: Array.isArray(r.ranked) ? r.ranked : [],
          reasoning: Array.isArray(r.reasoning) ? r.reasoning : [],
          agentStatus: actions.length ? "Awaiting your approval" : "Done",
          runs: [...p.runs, { id: runId, instruction: text, summary: r.summary ?? "", mode: r.mode, trace, time }],
          history: [...p.history, ...actions.map((a) => ({
            key: `${runId}-${a.id}`, time, request: text, tools, taskName: `${a.taskName} (#${a.taskId})`,
            proposed: `Reminder to ${a.owner}${a.cc ? `, CC ${a.cc}` : ""}`, approval: "Pending Approval" as const, actionId: a.id, runId,
          }))],
        };
      });
      toast("Agent finished", { description: actions.length ? `${actions.length} reminder(s) waiting for approval.` : "No actions proposed." });
    } catch (e) {
      patch({ running: false, agentStatus: "Error", error: errMsg(e) });
    }
  };

  const doApprove = async () => {
    setConfirmOpen(false);
    const selected = s.actions.filter((a) => s.selectedIds.includes(a.id));
    const unselected = s.actions.filter((a) => !s.selectedIds.includes(a.id));
    if (!selected.length || s.approving) return;
    const runId = s.runs.length;
    patch({ approving: true, agentStatus: "Executing", error: null });
    let results: ApproveResult[];
    try {
      const r = await approveActions(selected);
      results = Array.isArray(r?.results) ? r.results : [];
    } catch (e) {
      patch({ approving: false, agentStatus: "Error", error: errMsg(e) });
      return;
    }
    const rows: ResultRow[] = [
      ...selected.map((a) => {
        const r = results.find((x) => x.id === a.id);
        return { id: a.id, result: r?.result ?? "failed", detail: r?.detail ?? "No result returned for this action", taskId: a.taskId, taskName: a.taskName } as ResultRow;
      }),
      ...unselected.map((a) => ({ id: a.id, result: "skipped" as const, detail: "Not approved, nothing was recorded", taskId: a.taskId, taskName: a.taskName, notApproved: true })),
    ];
    const label = { done: "Completed", failed: "Failed", skipped: "Skipped" } as const;
    patch((p) => ({
      approving: false, agentStatus: "Verifying", results: rows, actions: [], selectedIds: [], approvedOnce: true,
      history: p.history.map((h) => {
        if (h.runId !== runId) return h;
        const row = rows.find((r) => r.id === h.actionId);
        if (!row) return h;
        if (row.notApproved) return { ...h, approval: "Skipped", result: "Skipped" };
        return { ...h, approval: "Approved", result: label[row.result], error: row.result === "failed" ? row.detail : undefined };
      }),
    }));
    toast("Approval complete", { description: `${rows.filter((r) => r.result === "done").length} done, checking the data source…` });

    const verification: Record<string, Verification> = {};
    try {
      const fresh = await getTasks();
      for (const r of rows) {
        if (r.notApproved) { verification[r.id] = "n/a"; continue; }
        verification[r.id] = fresh.find((t) => t.id === r.taskId)?.reminderSent ? "verified" : "not_verified";
      }
      patch((p) => ({ tasks: fresh, verification, verified: true, agentStatus: "Done", sources: { ...p.sources, tasks: { ...p.sources.tasks, checkedAt: new Date(), count: fresh.length } } }));
    } catch {
      for (const r of rows) verification[r.id] = r.notApproved ? "n/a" : "unavailable";
      patch({ verification, verified: true, agentStatus: "Done" });
    }
  };

  const tasks = s.tasks;
  const stats = useMemo(() => {
    const t = tasks ?? [];
    const done = t.filter((x) => x.status.toLowerCase() === "done").length;
    return {
      total: t.length, done, pending: t.length - done,
      overdue: t.filter((x) => daysOverdue(x.deadline, x.status) > 0).length,
      reminders: t.filter((x) => x.reminderSent).length,
    };
  }, [tasks]);
  const pending = s.actions.length;
  const connection = IS_DEMO ? "demo" : s.sources.tasks.status === "connected" ? "ok" : s.sources.tasks.status === "unreachable" ? "down" : "loading";

  const nav = (onClick?: () => void) => (
    <nav aria-label="Sections" className="flex flex-col gap-0.5">
      {NAV.map(({ id, label, icon: Icon }) => (
        <a key={id} href={`#${id}`} onClick={onClick}
          className="flex h-10 items-center gap-2.5 rounded-md px-3 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <Icon className="size-4 opacity-70" strokeWidth={1.75} />
          {label}
          {id === "approvals" && pending > 0 && (
            <span className="ml-auto rounded bg-sidebar-primary px-1.5 text-[11px] font-semibold text-sidebar-primary-foreground">{pending}</span>
          )}
        </a>
      ))}
    </nav>
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading TaskPilot…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-[14px]">
      <aside className="fixed inset-y-0 left-0 hidden w-[232px] flex-col bg-sidebar px-3 py-5 lg:flex">
        <Brand />
        <div className="mt-6">{nav()}</div>
        <div className="mt-auto border-t border-sidebar-border/60 pt-4">
          {user ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 rounded-lg border border-sidebar-border/60 bg-sidebar-accent/40 p-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-[11px] font-semibold text-sidebar-primary-foreground">
                    {user.isGuest ? <User className="size-3.5" /> : initials(user.name)}
                  </div>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate text-xs font-medium text-sidebar-foreground">{user.name}</p>
                    <p className="truncate text-[10px] text-sidebar-foreground/60">{user.isGuest ? "Guest" : user.email}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="rounded p-1 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut className="size-3.5" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => setPricingOpen(true)}
                className="flex w-full items-center justify-between rounded-lg border border-sidebar-border/50 bg-sidebar-accent/20 px-2.5 py-1.5 text-[11px] text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  <Sparkles className="size-3 text-indigo-400" />
                  Plans &amp; Quotas
                </span>
                <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-400">
                  Upgrade
                </span>
              </button>
            </div>
          ) : isDemo ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-sidebar-border/60 bg-sidebar-accent/40 p-2">
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-xs font-medium text-sidebar-foreground">Public Demo</p>
                <p className="truncate text-[10px] text-sidebar-foreground/60">Read-only mode</p>
              </div>
              <Link
                to="/login"
                className="rounded p-1 text-sidebar-foreground/60 hover:text-sidebar-foreground"
                title="Sign in"
                aria-label="Sign in"
              >
                <LogIn className="size-3.5" />
              </Link>
            </div>
          ) : (
            <Link
              to="/login"
              className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-sidebar-primary text-xs font-medium text-sidebar-primary-foreground hover:opacity-90"
            >
              <LogIn className="size-3.5" />
              <span>Sign In</span>
            </Link>
          )}
          <p className="mt-3 px-1 text-[11px] leading-relaxed text-sidebar-foreground/60">
            Connect data → Understand → Decide → Use tools → Execute → Verify
          </p>
        </div>
      </aside>

      <div className="lg:pl-[232px]">
        {user?.isGuest && !guestBannerDismissed && (
          <div className="border-b bg-amber-500/10 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-200">
            <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  <strong>You're a guest.</strong> Create an account to keep your workspace — guest data is deleted after about 7 days.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-amber-500/40 text-xs hover:bg-amber-500/20"
                  onClick={() => setUpgradeOpen(true)}
                >
                  Create an account
                </Button>
                <button
                  type="button"
                  onClick={dismissGuestBanner}
                  className="rounded p-1 text-muted-foreground hover:text-foreground"
                  aria-label="Dismiss guest notice"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mx-auto flex h-14 max-w-[1080px] items-center gap-2 px-4 sm:px-6">
            <Sheet open={mobileNav} onOpenChange={setMobileNav}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="size-10 lg:hidden" aria-label="Open menu"><Menu className="size-5" /></Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[260px] border-sidebar-border bg-sidebar p-3">
                <SheetHeader className="p-0"><SheetTitle className="sr-only">Navigation</SheetTitle><Brand /></SheetHeader>
                <div className="mt-6">{nav(() => setMobileNav(false))}</div>
              </SheetContent>
            </Sheet>
            <h1 className="mr-2 truncate text-[15px] font-semibold">Overdue work</h1>
            <div className="relative ml-auto hidden w-56 sm:block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <label htmlFor="search" className="sr-only">Search tasks by name or owner</label>
              <Input id="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks or owners" className="h-9 pl-8 text-[14px]" />
            </div>
            <ConnectionPill state={connection} />
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="relative size-10" aria-label={pending ? `${pending} proposals pending` : "Notifications, none pending"}>
                  <Bell className="size-[18px]" strokeWidth={1.75} />
                  {pending > 0 && <span className="absolute right-2.5 top-2.5 size-2 rounded-full bg-danger" />}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 text-sm">
                {pending ? (
                  <div>
                    <p className="font-medium">{pending} reminder{pending > 1 ? "s" : ""} waiting for approval</p>
                    <a href="#approvals" className="mt-2 inline-block text-primary underline-offset-4 hover:underline">Review approvals</a>
                  </div>
                ) : <p className="text-muted-foreground">Nothing needs your attention.</p>}
              </PopoverContent>
            </Popover>
            {user && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPricingOpen(true)}
                className="hidden sm:inline-flex h-9 items-center gap-1.5 text-xs font-semibold border-indigo-500/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10"
              >
                <Sparkles className="size-3.5 text-indigo-500" />
                <span>Plans</span>
              </Button>
            )}
            <Button variant="ghost" size="icon" className="size-10" aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={() => setDark((d) => !d)}>
              {dark ? <Sun className="size-[18px]" strokeWidth={1.75} /> : <Moon className="size-[18px]" strokeWidth={1.75} />}
            </Button>
            {user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="relative flex size-9 items-center justify-center rounded-full bg-secondary text-xs font-semibold ring-1 ring-border transition-all hover:scale-105 hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Account menu for ${user.name}`}
                  >
                    {user.isGuest ? (
                      <User className="size-4 text-muted-foreground" />
                    ) : (
                      <span>{initials(user.name)}</span>
                    )}
                    {user.isGuest && (
                      <span className="absolute -bottom-0.5 -right-0.5 flex size-2.5 items-center justify-center rounded-full bg-primary ring-2 ring-background" title="Guest Mode Active" />
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64 p-1.5 shadow-lg">
                  <DropdownMenuLabel className="p-2 font-normal">
                    <div className="flex flex-col space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="truncate text-sm font-semibold">{user.name}</p>
                        {user.isGuest ? (
                          <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/25">
                            Guest
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            Account
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{user.isGuest ? "Temporary session" : user.email}</p>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="cursor-pointer flex items-center gap-2 text-xs"
                    onClick={() => setPricingOpen(true)}
                  >
                    <CreditCard className="size-3.5 text-indigo-500" />
                    <span>Plans &amp; Usage</span>
                  </DropdownMenuItem>
                  {user.isGuest && (
                    <DropdownMenuItem
                      className="cursor-pointer flex items-center gap-2 text-xs"
                      onClick={() => setUpgradeOpen(true)}
                    >
                      <Sparkles className="size-3.5 text-primary" />
                      <span>Upgrade to Permanent Account</span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem asChild>
                    <Link to="/login" className="cursor-pointer flex items-center gap-2 text-xs">
                      <UserCheck className="size-3.5" />
                      <span>Switch Account</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="cursor-pointer text-destructive focus:text-destructive flex items-center gap-2 text-xs"
                    onClick={handleSignOut}
                  >
                    <LogOut className="size-3.5" />
                    <span>Sign Out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Link
                to="/login"
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                <LogIn className="size-3.5" />
                <span className="hidden sm:inline">Sign In</span>
              </Link>
            )}
          </div>
          <div className="px-4 pb-2 sm:hidden">
            <label htmlFor="search-m" className="sr-only">Search tasks by name or owner</label>
            <Input id="search-m" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks or owners" className="h-10 text-base" />
          </div>
        </header>

        <main className="mx-auto max-w-[1080px] space-y-12 px-4 py-6 sm:px-6">
          <div aria-live="polite" className="sr-only">
            {`Agent status: ${s.agentStatus}.`} {s.verified && `${s.results.length} results ready.`}
          </div>
          {s.error && (
            <Alert variant="destructive" className="fade-in pr-12">
              <AlertTriangle className="size-4" />
              <AlertTitle>Something needs attention</AlertTitle>
              <AlertDescription>{s.error}</AlertDescription>
              <button onClick={() => patch({ error: null })} aria-label="Dismiss error" className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-md hover:bg-danger-soft">
                <X className="size-4" />
              </button>
            </Alert>
          )}

          <Overview s={s} stats={stats} />
          <ConnectedData
            s={s}
            query={query}
            currentWorkspace={currentWorkspace}
            workspaces={workspaces}
            onSelectWorkspace={(val) => {
              if (val === "demo") {
                setCurrentWorkspace(null);
              } else {
                const ws = workspaces.find((w) => w.id === val);
                if (ws) setCurrentWorkspace(ws);
              }
            }}
            onOpenNewWorkspace={() => setNewWorkspaceOpen(true)}
            onOpenDeleteWorkspace={() => setDeleteWorkspaceOpen(true)}
            onOpenNewTask={() => setNewTaskOpen(true)}
            onDeleteTask={handleDeleteTask}
            isUserAuthenticated={Boolean(user)}
          />
          <AgentSection s={s} instruction={instruction} setInstruction={setInstruction} onRun={doRun} />
          <ToolActivity runs={s.runs} />
          <Approvals s={s} patch={patch} onApprove={() => setConfirmOpen(true)} />
          <HistorySection rows={s.history} />
          <Insights s={s} />

          <footer className="border-t pt-6 pb-10 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-4">
            <span>Reminders are simulated. No real emails are sent.</span>
            <div className="flex items-center gap-3">
              <Link to="/terms" className="hover:underline">Terms</Link>
              <span>•</span>
              <Link to="/privacy" className="hover:underline">Privacy</Link>
              <span>•</span>
              <Link to="/refund" className="hover:underline">Refunds</Link>
            </div>
          </footer>
        </main>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {s.selectedIds.length} reminder(s)?</AlertDialogTitle>
            <AlertDialogDescription>Messages are recorded in simulated mode and no real emails are sent.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doApprove}>Approve</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Guest Upgrade Dialog */}
      <Dialog open={upgradeOpen} onOpenChange={setUpgradeOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Keep Your Workspace</DialogTitle>
            <DialogDescription>
              Link an email and password to convert your guest session into a permanent account.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleUpgrade} className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label htmlFor="upgrade-email" className="text-xs font-medium">Email address</label>
              <Input
                id="upgrade-email"
                type="email"
                value={upgradeEmail}
                onChange={(e) => setUpgradeEmail(e.target.value)}
                placeholder="you@example.com"
                required
                disabled={upgrading}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="upgrade-password" className="text-xs font-medium">Password</label>
              <Input
                id="upgrade-password"
                type="password"
                value={upgradePassword}
                onChange={(e) => setUpgradePassword(e.target.value)}
                placeholder="At least 6 characters"
                required
                minLength={6}
                disabled={upgrading}
              />
            </div>
            {upgradeError && (
              <p className="text-xs text-destructive">{upgradeError}</p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setUpgradeOpen(false)}
                disabled={upgrading}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={upgrading || !upgradeEmail || !upgradePassword}>
                {upgrading && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Upgrade Account
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* New Workspace Dialog */}
      <Dialog open={newWorkspaceOpen} onOpenChange={setNewWorkspaceOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Create Workspace</DialogTitle>
            <DialogDescription>
              Workspaces isolate your project tasks and graph data in FalkorDB.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateWorkspace} className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label htmlFor="ws-name" className="text-xs font-medium">Workspace Name</label>
              <Input
                id="ws-name"
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder="e.g. Q4 Sprint, Launch Team"
                maxLength={50}
                required
                disabled={creatingWorkspace}
              />
            </div>
            {workspaceError && (
              <p className="text-xs text-destructive">{workspaceError}</p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewWorkspaceOpen(false)}
                disabled={creatingWorkspace}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creatingWorkspace || !newWorkspaceName.trim()}>
                {creatingWorkspace && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Workspace Alert Dialog */}
      <AlertDialog open={deleteWorkspaceOpen} onOpenChange={setDeleteWorkspaceOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workspace "{currentWorkspace?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this workspace, including all of its tasks and graph data from FalkorDB. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingWorkspace}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteWorkspace}
              disabled={deletingWorkspace}
            >
              {deletingWorkspace && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Delete Workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* New Task Dialog */}
      <Dialog open={newTaskOpen} onOpenChange={setNewTaskOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Add New Task</DialogTitle>
            <DialogDescription>
              Create a task with owners and dependencies in "{currentWorkspace?.name}".
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateTask} className="space-y-3 pt-2">
            <div className="space-y-1">
              <label htmlFor="task-name" className="text-xs font-medium">Task Name *</label>
              <Input
                id="task-name"
                value={taskForm.name}
                onChange={(e) => setTaskForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Finalize security review"
                required
                disabled={creatingTask}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label htmlFor="task-owner" className="text-xs font-medium">Owner Name *</label>
                <Input
                  id="task-owner"
                  value={taskForm.owner}
                  onChange={(e) => setTaskForm((f) => ({ ...f, owner: e.target.value }))}
                  placeholder="e.g. Alex Chen"
                  required
                  disabled={creatingTask}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="task-email" className="text-xs font-medium">Owner Email</label>
                <Input
                  id="task-email"
                  type="email"
                  value={taskForm.ownerEmail}
                  onChange={(e) => setTaskForm((f) => ({ ...f, ownerEmail: e.target.value }))}
                  placeholder="alex@company.com"
                  disabled={creatingTask}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label htmlFor="task-project" className="text-xs font-medium">Project *</label>
                <Input
                  id="task-project"
                  value={taskForm.project}
                  onChange={(e) => setTaskForm((f) => ({ ...f, project: e.target.value }))}
                  placeholder="Core"
                  required
                  disabled={creatingTask}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="task-manager" className="text-xs font-medium">Manager</label>
                <Input
                  id="task-manager"
                  value={taskForm.manager}
                  onChange={(e) => setTaskForm((f) => ({ ...f, manager: e.target.value }))}
                  placeholder="e.g. Sarah"
                  disabled={creatingTask}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label htmlFor="task-deadline" className="text-xs font-medium">Deadline</label>
                <Input
                  id="task-deadline"
                  type="date"
                  value={taskForm.deadline}
                  onChange={(e) => setTaskForm((f) => ({ ...f, deadline: e.target.value }))}
                  disabled={creatingTask}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="task-status" className="text-xs font-medium">Status</label>
                <Select
                  value={taskForm.status}
                  onValueChange={(val) => setTaskForm((f) => ({ ...f, status: val }))}
                >
                  <SelectTrigger id="task-status" className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Not Started">Not Started</SelectItem>
                    <SelectItem value="In Progress">In Progress</SelectItem>
                    <SelectItem value="Blocked">Blocked</SelectItem>
                    <SelectItem value="Done">Done</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {s.tasks && s.tasks.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs font-medium">Depends on existing tasks (optional)</label>
                <div className="max-h-24 overflow-y-auto rounded-md border p-2 space-y-1 text-xs">
                  {s.tasks.map((t) => (
                    <label key={t.id} className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={taskForm.dependsOn.includes(t.id)}
                        onCheckedChange={(checked) => {
                          setTaskForm((f) => ({
                            ...f,
                            dependsOn: checked
                              ? [...f.dependsOn, t.id]
                              : f.dependsOn.filter((id) => id !== t.id),
                          }));
                        }}
                      />
                      <span className="truncate">#{t.id} {t.name} ({t.owner})</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {taskError && (
              <p className="text-xs text-destructive">{taskError}</p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewTaskOpen(false)}
                disabled={creatingTask}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creatingTask || !taskForm.name.trim() || !taskForm.owner.trim()}>
                {creatingTask && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Save Task
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {/* Plans & Usage Pricing Modal */}
      <PricingModal
        open={pricingOpen}
        onClose={() => setPricingOpen(false)}
        onOpenUpgradeGuest={() => setUpgradeOpen(true)}
      />

      {/* Floating Rule-based Help Assistant */}
      <ChatbotWidget
        onOpenPricing={() => setPricingOpen(true)}
        onOpenNewWorkspace={() => setNewWorkspaceOpen(true)}
        onOpenNewTask={() => setNewTaskOpen(true)}
      />
    </div>
  );
}

/* ---------------- small pieces ---------------- */
function Brand() {
  return (
    <div className="flex items-center gap-2 px-3">
      <div className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
        <Activity className="size-4" strokeWidth={2} />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-sidebar-accent-foreground">TaskPilot AI</p>
        <p className="text-[11px] text-sidebar-foreground/60">Connected info to real actions</p>
      </div>
    </div>
  );
}

function ConnectionPill({ state }: { state: "demo" | "ok" | "down" | "loading" }) {
  const map = {
    demo: ["bg-demo-soft text-demo", "Demo mode"],
    ok: ["bg-success-soft text-success", "Backend connected"],
    down: ["bg-danger-soft text-danger", "Backend unreachable"],
    loading: ["bg-muted text-muted-foreground", "Checking backend…"],
  } as const;
  const [cls, label] = map[state];
  return (
    <span className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium", cls)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      <span className="hidden md:inline">{label}</span>
      <span className="sr-only md:hidden">{label}</span>
    </span>
  );
}

function SectionHead({ eyebrow, title, sub, right }: { eyebrow: string; title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="panel border-dashed px-5 py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

const Tag = ({ tone, children, className }: { tone: "success" | "warning" | "danger" | "info" | "demo" | "muted" | "accent"; children: React.ReactNode; className?: string }) => {
  const tones = {
    success: "bg-success-soft text-success", warning: "bg-warning-soft text-warning", danger: "bg-danger-soft text-danger",
    info: "bg-info-soft text-info", demo: "bg-demo-soft text-demo", muted: "bg-muted text-muted-foreground", accent: "bg-accent text-accent-foreground",
  };
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", tones[tone], className)}>{children}</span>;
};

/* ---------------- sections ---------------- */
function Overview({ s, stats }: { s: State; stats: { total: number; done: number; pending: number; overdue: number; reminders: number } }) {
  const loading = s.tasks === null;
  const steps = [
    ["Connect", s.tasks !== null && s.sources.tasks.status !== "unreachable"],
    ["Understand", s.ranOnce],
    ["Decide", s.runs.length > 0 && !s.running],
    ["Use tools", s.trace.length > 0],
    ["Execute", s.approvedOnce],
    ["Verify", s.verified],
  ] as const;
  const statusTone: Record<AgentStatus, string> = {
    Idle: "text-muted-foreground", Working: "text-primary", "Awaiting your approval": "text-warning",
    Executing: "text-primary", Verifying: "text-primary", Done: "text-success", Error: "text-danger",
  };
  const cards = [
    ["Total", stats.total], ["Completed", stats.done], ["Pending", stats.pending], ["Overdue", stats.overdue], ["Reminders recorded", stats.reminders],
  ] as const;
  return (
    <section id="overview" aria-labelledby="h-overview">
      <p className="eyebrow">Overview</p>
      <h2 id="h-overview" className="mt-1 text-2xl font-semibold tracking-tight">
        {loading ? "Loading tasks…" : stats.overdue ? `${stats.overdue} task${stats.overdue > 1 ? "s are" : " is"} past deadline` : "Nothing is past deadline"}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Tracks {loading ? "…" : stats.total} tasks across 1 project. Reminders only, nothing is sent externally.
      </p>

      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_260px]">
        <div className="panel grid grid-cols-2 divide-border sm:grid-cols-5 sm:divide-x">
          {cards.map(([label, v]) => (
            <div key={label} className="px-4 py-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              {loading ? <Skeleton className="mt-1.5 h-7 w-10" /> : (
                <p className={cn("mt-0.5 text-2xl font-semibold tabular-nums", label === "Overdue" && v > 0 && "text-danger")}>{v}</p>
              )}
            </div>
          ))}
        </div>
        <div className="panel flex items-center gap-3 px-4 py-3">
          {s.running || s.approving || s.agentStatus === "Verifying" ? <Loader2 className="size-5 animate-spin text-primary" /> : <Bot className="size-5 text-muted-foreground" strokeWidth={1.75} />}
          <div>
            <p className="text-xs text-muted-foreground">Agent status</p>
            <p className={cn("font-semibold", statusTone[s.agentStatus])}>{s.agentStatus}</p>
          </div>
        </div>
      </div>

      <ol className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2 text-xs" aria-label="Agent progress">
        {steps.map(([label, on], i) => (
          <li key={label} className="flex items-center gap-1">
            <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 transition-colors",
              on ? "border-primary/40 bg-accent font-medium text-accent-foreground" : "bg-card text-muted-foreground")}>
              {on ? <Check className="size-3" /> : <span className="font-mono text-[10px]">{i + 1}</span>}
              {label}
            </span>
            {i < steps.length - 1 && <span className="text-muted-foreground/50" aria-hidden>—</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ConnectedData({
  s,
  query,
  currentWorkspace,
  workspaces,
  onSelectWorkspace,
  onOpenNewWorkspace,
  onOpenDeleteWorkspace,
  onOpenNewTask,
  onDeleteTask,
  isUserAuthenticated,
}: {
  s: State;
  query: string;
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  onSelectWorkspace: (val: string) => void;
  onOpenNewWorkspace: () => void;
  onOpenDeleteWorkspace: () => void;
  onOpenNewTask: () => void;
  onDeleteTask: (id: number) => void;
  isUserAuthenticated: boolean;
}) {
  const [status, setStatus] = useState("all");
  const [owner, setOwner] = useState("all");
  const [deadline, setDeadline] = useState("all");
  const [priority, setPriority] = useState("all");
  const tasks = s.tasks ?? [];
  const statuses = [...new Set(tasks.map((t) => t.status))];
  const owners = [...new Set(tasks.map((t) => t.owner))];
  const priorities = [...new Set(tasks.map((t) => t.priority).filter(Boolean) as string[])];
  const rankIdx = new Map(s.ranked.map((r, i) => [r.taskId, { ...r, i }]));
  const q = query.trim().toLowerCase();
  const rows = tasks.filter((t) => {
    const od = daysOverdue(t.deadline, t.status);
    if (q && !t.name.toLowerCase().includes(q) && !t.owner.toLowerCase().includes(q)) return false;
    if (status !== "all" && t.status !== status) return false;
    if (owner !== "all" && t.owner !== owner) return false;
    if (priority !== "all" && t.priority !== priority) return false;
    if (deadline === "overdue" && od <= 0) return false;
    if (deadline === "week") {
      const [y, m, d] = t.deadline.split("-").map(Number);
      const diff = Math.round((new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
      if (diff < 0 || diff > 7) return false;
    }
    return true;
  });

  const src = (name: string, path: string, st: SourceState, unit: string) => {
    const map = {
      loading: ["muted", "Checking…"], connected: ["success", "Connected"], unreachable: ["danger", "Unreachable"], sample: ["demo", "Sample data"],
    } as const;
    const [tone, label] = map[st.status];
    return (
      <div className="panel flex items-start justify-between gap-3 px-4 py-3">
        <div>
          <p className="font-medium">{name}</p>
          <p className="font-mono text-xs text-muted-foreground">{path}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {st.count !== undefined ? `${st.count} ${unit}` : "—"} · checked {st.checkedAt ? <span className="font-mono">{fmtTime(st.checkedAt)}</span> : "…"}
          </p>
        </div>
        <Tag tone={tone}>{label}</Tag>
      </div>
    );
  };

  const filter = (id: string, label: string, val: string, set: (v: string) => void, opts: [string, string][]) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
      <Select value={val} onValueChange={set}>
        <SelectTrigger id={id} className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
        <SelectContent>{opts.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );

  return (
    <section id="data" aria-labelledby="h-data">
      <SectionHead eyebrow="Connected Data" title="What the agent reads" sub="Each source below is fetched by this page. Status reflects the last request." />
      <div className="grid gap-3 sm:grid-cols-2">
        {src("Task records", "/api/tasks", s.sources.tasks, "records")}
        {src("Dependency graph", "/api/graph", s.sources.graph, "nodes")}
      </div>

      {/* Workspace Picker Toolbar */}
      <div className="panel mt-4 p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Database className="size-4 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workspace:</span>
          </div>
          <Select
            value={currentWorkspace?.id || "demo"}
            onValueChange={onSelectWorkspace}
          >
            <SelectTrigger className="h-9 w-[220px]">
              <SelectValue placeholder="Select workspace" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="demo">Demo data (read-only)</SelectItem>
              {workspaces.map((ws) => (
                <SelectItem key={ws.id} value={ws.id}>
                  {ws.name}{ws.expires_at ? " (Guest)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {isUserAuthenticated && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={onOpenNewWorkspace}
            >
              <FolderPlus className="size-3.5" />
              <span>New Workspace</span>
            </Button>
          )}

          {currentWorkspace && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
              onClick={onOpenDeleteWorkspace}
            >
              <Trash2 className="size-3.5" />
              <span className="hidden sm:inline">Delete Workspace</span>
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {currentWorkspace ? (
            <Button
              size="sm"
              className="h-9 gap-1.5"
              onClick={onOpenNewTask}
            >
              <Plus className="size-3.5" />
              <span>Add Task</span>
            </Button>
          ) : (
            <Badge variant="outline" className="text-xs py-1 px-2.5 text-muted-foreground border-dashed">
              Public Demo (Read-only)
            </Badge>
          )}
        </div>
      </div>

      <div className="panel mt-4">
        <div className="flex flex-wrap gap-3 border-b px-4 py-3">
          {filter("f-status", "Status", status, setStatus, [["all", "All statuses"], ...statuses.map((x) => [x, x] as [string, string])])}
          {filter("f-owner", "Owner", owner, setOwner, [["all", "All owners"], ...owners.map((x) => [x, x] as [string, string])])}
          {filter("f-deadline", "Deadline", deadline, setDeadline, [["all", "Any deadline"], ["overdue", "Overdue"], ["week", "Due this week"]])}
          {priorities.length > 0 && filter("f-priority", "Priority", priority, setPriority, [["all", "Any priority"], ...priorities.map((x) => [x, x] as [string, string])])}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13.5px]">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                {["Task", "Owner", "Deadline", "Status", "Recommendation", ...(currentWorkspace ? ["Actions"] : [])].map((h) => (
                  <th key={h} scope="col" className={cn("px-4 py-2 font-medium", h === "Actions" && "text-right")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.tasks === null && Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b last:border-0">{Array.from({ length: currentWorkspace ? 6 : 5 }).map((__, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>)}</tr>
              ))}
              {rows.map((t) => {
                const od = daysOverdue(t.deadline, t.status);
                const done = t.status.toLowerCase() === "done";
                const r = rankIdx.get(t.id);
                return (
                  <tr key={t.id} className={cn("border-b transition-colors last:border-0", od > 0 && "bg-danger-soft/60")}>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{t.name}</span>
                        {t.reminderSent && <Tag tone="success"><CheckCircle2 className="size-3" />Reminder sent</Tag>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">{t.owner}</td>
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-xs">{t.deadline}</span>
                      {od > 0 && <Tag tone="danger" className="ml-2">Overdue by {od} day{od > 1 ? "s" : ""}</Tag>}
                    </td>
                    <td className="px-4 py-2.5">{done ? <Tag tone="success"><Check className="size-3" />Done</Tag> : <Tag tone="muted">{t.status}</Tag>}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {r ? <span className={cn(r.i === 0 && "font-medium text-foreground")}>{r.i === 0 ? "Chase first" : `Chase #${r.i + 1}`}, blocks {r.blocksCount}</span> : "—"}
                    </td>
                    {currentWorkspace && (
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-destructive"
                          title="Delete task"
                          aria-label={`Delete task ${t.name}`}
                          onClick={() => onDeleteTask(t.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {s.tasks !== null && rows.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {tasks.length ? "No tasks match these filters. Clear the search or pick another filter." : "No task records were loaded. Check the backend connection and reload."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function AgentSection({ s, instruction, setInstruction, onRun }: { s: State; instruction: string; setInstruction: (v: string) => void; onRun: (v: string) => void }) {
  const busy = s.running || s.approving;
  return (
    <section id="agent" aria-labelledby="h-agent">
      <SectionHead eyebrow="AI Agent" title="Tell the agent what to look for" />
      <div className="panel p-4">
        <form onSubmit={(e) => { e.preventDefault(); onRun(instruction); }} className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <label htmlFor="instruction" className="sr-only">Instruction</label>
            <Input id="instruction" value={instruction} maxLength={500} disabled={busy}
              onChange={(e) => setInstruction(e.target.value.slice(0, 500))} className="h-11 pr-16 text-base" />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">{instruction.length}/500</span>
          </div>
          <Button type="submit" disabled={busy || !instruction.trim()} className="h-11 px-5">
            {s.running ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}Run agent
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" disabled={busy} onClick={() => setInstruction(ex)}
              className="min-h-9 rounded-md border bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              {ex}
            </button>
          ))}
        </div>

        {(s.runs.length > 0 || s.running) && (
          <div className="mt-5 space-y-4 border-t pt-4">
            {s.runs.map((r) => (
              <div key={r.id} className="fade-in space-y-2">
                <div className="ml-auto w-fit max-w-[85%] rounded-lg bg-secondary px-3 py-2">{r.instruction}</div>
                <div className="max-w-[90%] rounded-lg border px-3 py-2.5">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <ModeBadge mode={r.mode} />
                    <span className="font-mono text-[11px] text-muted-foreground">{fmtTime(r.time)}</span>
                  </div>
                  <p className="leading-relaxed">{r.summary || "The agent returned no summary."}</p>
                </div>
              </div>
            ))}
            {s.running && (
              <div className="space-y-2" role="status">
                <div className="ml-auto w-fit max-w-[85%] rounded-lg bg-secondary px-3 py-2">{instruction.trim()}</div>
                <div className="max-w-[90%] rounded-lg border px-3 py-2.5">
                  <p className="text-sm text-muted-foreground">Agent is working…</p>
                  <div className="shimmer mt-2 h-2.5 w-3/4 rounded" />
                  <div className="shimmer mt-1.5 h-2.5 w-1/2 rounded" />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ModeBadge({ mode }: { mode: "llm" | "deterministic" }) {
  return mode === "llm" ? (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-info/30 bg-info-soft px-2 py-0.5 text-xs font-semibold text-info">
      <Sparkles className="size-3" />Real LLM tool-calling
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-md border-2 border-warning/50 bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning">
      <AlertTriangle className="size-3" />Deterministic demo flow, no LLM used
    </span>
  );
}

function ToolActivity({ runs }: { runs: Run[] }) {
  return (
    <section id="tools" aria-labelledby="h-tools">
      <SectionHead eyebrow="Tool Activity" title="Calls the agent made" sub="The trace records calls only, not per-call outcomes." />
      {runs.length === 0 ? <Empty>Run the agent to see which tools it calls and with what arguments.</Empty> : (
        <div className="space-y-3">
          {[...runs].reverse().map((r) => (
            <div key={r.id} className="fade-in overflow-hidden rounded-xl border">
              <div className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-2.5">
                <span className="text-sm font-medium">Run {r.id}</span>
                <ModeBadge mode={r.mode} />
                <span className="font-mono text-[11px] text-muted-foreground">{fmtTime(r.time)}</span>
                <div className="ml-auto flex flex-wrap gap-1">
                  {toolsOf(r.trace).map((t) => <Tag key={t} tone="accent" className="font-mono">{t}</Tag>)}
                </div>
              </div>
              {r.trace.length === 0 ? <p className="bg-terminal px-4 py-4 font-mono text-xs text-terminal-foreground/70">No tool calls were reported.</p> : (
                <ol className="max-h-72 overflow-auto bg-terminal px-4 py-3 font-mono text-[12.5px] leading-6 text-terminal-foreground">
                  {r.trace.map((entry, i) => {
                    const p = parseTrace(entry);
                    return (
                      <li key={i} className="flex gap-3">
                        <span className="w-6 shrink-0 text-right opacity-40">{i + 1}</span>
                        <span className="shrink-0 opacity-50">called</span>
                        {p ? <span className="break-all"><span className="text-sidebar-primary">{p.tool}</span><span className="opacity-70">({p.args})</span></span> : <span className="break-all">{entry}</span>}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Approvals({ s, patch, onApprove }: { s: State; patch: (p: Partial<State>) => void; onApprove: () => void }) {
  const n = s.selectedIds.length;
  const toggle = (id: string) => patch({ selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id] });
  return (
    <section id="approvals" aria-labelledby="h-approvals">
      <SectionHead eyebrow="Action Approvals" title="Pending approvals" sub="Nothing is sent until you approve."
        right={s.actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" className="h-10" onClick={() => patch({ selectedIds: s.actions.map((a) => a.id) })}>Select all</Button>
            <Button variant="ghost" size="sm" className="h-10" onClick={() => patch({ selectedIds: [] })}>None</Button>
            <span className="text-sm tabular-nums text-muted-foreground">{n} selected</span>
            <Button className="h-10" disabled={n === 0 || s.approving} onClick={onApprove}>
              {s.approving && <Loader2 className="size-4 animate-spin" />}Approve selected
            </Button>
          </div>
        )} />
      {s.actions.length === 0 ? (
        <Empty>{s.approvedOnce ? "All proposals from the last run were handled. Run the agent again for new drafts." : "No reminders are waiting. Run the agent and its drafts will appear here for review."}</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {s.actions.map((a) => {
            const on = s.selectedIds.includes(a.id);
            return (
              <div key={a.id} className={cn("panel fade-in p-4 transition-colors", on && "border-primary/40")}>
                <div className="flex items-start gap-3">
                  <Checkbox id={`sel-${a.id}`} checked={on} onCheckedChange={() => toggle(a.id)} className="mt-2.5" aria-label={`Select reminder for ${a.owner}`} />
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold">{initials(a.owner)}</div>
                  <div className="min-w-0 flex-1">
                    <label htmlFor={`sel-${a.id}`} className="block cursor-pointer font-medium">{a.owner} · <span className="font-normal">{a.taskName}</span></label>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs text-muted-foreground">{a.email}</span>
                      {a.cc && <Tag tone="info">CC: {a.cc}</Tag>}
                    </div>
                  </div>
                </div>
                <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted px-3 py-2.5 text-[13.5px] leading-relaxed">{a.message}</p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function HistorySection({ rows }: { rows: HistoryRow[] }) {
  const tone = (v?: string) => v === "Completed" ? "success" : v === "Failed" ? "danger" : v === "Skipped" ? "warning" : v === "Approved" ? "info" : v === "Pending Approval" ? "muted" : "muted";
  return (
    <section id="history" aria-labelledby="h-history">
      <SectionHead eyebrow="Execution History" title="Session audit log" sub="Rows come only from agent runs and approval responses in this session." />
      {rows.length === 0 ? <Empty>The log is empty. It fills in as soon as the agent proposes its first action.</Empty> : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-[13px]">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">{["Time", "Request", "Tool(s)", "Task affected", "Proposed action", "Approval", "Result", "Error"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.key} className="border-b align-top last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{fmtTime(r.time)}</td>
                  <td className="max-w-[180px] px-3 py-2 text-muted-foreground">{r.request}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{r.tools.join(", ") || "—"}</td>
                  <td className="px-3 py-2">{r.taskName}</td>
                  <td className="px-3 py-2">{r.proposed}</td>
                  <td className="px-3 py-2"><Tag tone={tone(r.approval)}>{r.approval === "Skipped" ? "Skipped (not approved)" : r.approval}</Tag></td>
                  <td className="px-3 py-2">{r.result ? <Tag tone={tone(r.result)}>{r.result}</Tag> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-2 text-danger">{r.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Insights({ s }: { s: State }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const tasks = s.tasks ?? [];
  const overdueTasks = s.overdueIds.map((id) => tasks.find((t) => t.id === id)).filter(Boolean) as Task[];
  const statusData = [...new Set(tasks.map((t) => t.status))].map((st) => ({ label: st, value: tasks.filter((t) => t.status === st).length }));
  const odData = tasks.map((t) => ({ label: `#${t.id}`, value: daysOverdue(t.deadline, t.status) })).filter((d) => d.value > 0);
  const tally = {
    done: s.results.filter((r) => r.result === "done").length,
    failed: s.results.filter((r) => r.result === "failed").length,
    skipped: s.results.filter((r) => r.result === "skipped" && !r.notApproved).length,
    notApproved: s.results.filter((r) => r.notApproved).length,
  };

  return (
    <section id="insights" aria-labelledby="h-insights">
      <SectionHead eyebrow="Results & Insights" title="What happened and what matters" />

      <div className="panel mb-4" aria-live="polite">
        <div className="border-b px-4 py-3"><h3 className="font-medium">Execution results</h3></div>
        {s.results.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Approve at least one reminder and the backend's response will be shown here, then checked against the data source.</p>
        ) : (
          <>
            <ul className="divide-y">
              {s.results.map((r) => {
                const v = s.verification[r.id];
                return (
                  <li key={r.id} className="fade-in flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
                    <span className="mt-0.5 shrink-0">
                      {r.result === "done" ? <CheckCircle2 className="size-4 text-success" aria-label="done" /> : r.result === "failed" ? <XCircle className="size-4 text-danger" aria-label="failed" /> : <Minus className="size-4 text-warning" aria-label="skipped" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{r.taskName} <span className="font-mono text-xs font-normal text-muted-foreground">#{r.taskId}</span>
                        <span className="ml-2 text-xs font-normal text-muted-foreground">{r.notApproved ? "Skipped (not approved)" : r.result}</span></p>
                      <p className="text-sm text-muted-foreground">{r.detail}</p>
                    </div>
                    <div className="text-xs sm:text-right">
                      {v === undefined && !r.notApproved && <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" />Verifying…</span>}
                      {v === "verified" && <Tag tone="success"><Check className="size-3" />Verified: reminder recorded on the task</Tag>}
                      {v === "not_verified" && <Tag tone="warning"><AlertTriangle className="size-3" />Not verified</Tag>}
                      {v === "unavailable" && <Tag tone="muted">Verification unavailable</Tag>}
                      {v === "n/a" && <span className="text-muted-foreground">Nothing to verify</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="border-t px-4 py-2.5 text-sm tabular-nums">
              {tally.done} done, {tally.failed} failed, {tally.skipped + tally.notApproved} skipped
              {tally.notApproved > 0 && tally.skipped > 0 ? ` (${tally.notApproved} not approved, ${tally.skipped} already recorded)` : tally.notApproved > 0 ? " (not approved)" : tally.skipped > 0 ? " (already recorded)" : ""}
            </p>
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
        <div className="panel p-4">
          <h3 className="font-medium">Priority order</h3>
          {s.ranked.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Ranking appears after a run that returns dependency data.</p> : (
            <ol className="mt-3 space-y-2">
              {s.ranked.map((r, i) => (
                <li key={r.taskId} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
                  <span className="flex size-6 items-center justify-center rounded bg-foreground font-mono text-xs font-semibold text-background">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground">{r.owner} · {r.daysOverdue} day{r.daysOverdue === 1 ? "" : "s"} overdue</p>
                  </div>
                  <Tag tone="accent">Blocks {r.blocksCount} task{r.blocksCount === 1 ? "" : "s"}</Tag>
                </li>
              ))}
            </ol>
          )}
          {s.reasoning.length > 0 && (
            <div className="mt-4 rounded-md bg-muted px-3 py-3">
              <p className="text-xs font-semibold">Why this order?</p>
              <ul className="mt-2 space-y-1.5 font-mono text-[12px] leading-relaxed">
                {s.reasoning.map((line, i) => (
                  <li key={i}>{line.split(/\s*→\s*/).map((part, j, arr) => (
                    <span key={j}><span className={part === "blocks" ? "text-muted-foreground" : ""}>{part}</span>{j < arr.length - 1 && <span className="px-1.5 text-muted-foreground">→</span>}</span>
                  ))}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="panel p-4">
          <h3 className="font-medium">Needs attention</h3>
          {overdueTasks.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Run the agent to list which overdue tasks it found.</p> : (
            <ul className="mt-3 divide-y">
              {overdueTasks.map((t) => {
                const d = daysOverdue(t.deadline, t.status);
                return (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                    <div><p className="font-medium">{t.name}</p><p className="text-xs text-muted-foreground">{t.owner}</p></div>
                    <Tag tone="danger">{d} day{d === 1 ? "" : "s"} overdue</Tag>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="panel p-4">
          <h3 className="mb-2 text-sm font-medium">Tasks by status</h3>
          {mounted && tasks.length ? <StatusChart data={statusData} /> : <Skeleton className="h-44 w-full" />}
        </div>
        <div className="panel p-4">
          <h3 className="mb-2 text-sm font-medium">Days overdue per task</h3>
          {mounted && s.tasks ? (odData.length ? <OverdueChart data={odData} /> : <p className="py-14 text-center text-sm text-muted-foreground">No task is overdue.</p>) : <Skeleton className="h-44 w-full" />}
        </div>
      </div>

      <div className="panel mt-4 p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="font-medium">Dependency graph</h3>
          <span className="text-xs text-muted-foreground">Hover a node for details</span>
        </div>
        {s.graphError ? (
          <p className="text-sm text-danger">Couldn't load the graph: {s.graphError}</p>
        ) : s.graph ? <DependencyGraph graph={s.graph} overdueIds={s.overdueIds} /> : <Skeleton className="h-60 w-full" />}
      </div>
    </section>
  );
}
