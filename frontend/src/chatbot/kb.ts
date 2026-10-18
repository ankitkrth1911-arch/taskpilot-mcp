/**
 * Rule-based Knowledge Base for TaskPilot AI Help Chatbot.
 * Strictly local, deterministic pattern matching with zero external AI or API calls.
 * Plain-text responses only.
 */

export interface FAQItem {
  id: string;
  topic: string;
  keywords: string[];
  question: string;
  answer: string;
  followUpChips?: string[];
  action?: {
    label: string;
    type: "open_pricing" | "open_new_workspace" | "open_new_task" | "contact_support";
  };
}

export const KNOWLEDGE_BASE: FAQItem[] = [
  {
    id: "kb_plans",
    topic: "plans_quotas",
    keywords: ["price", "pricing", "cost", "plan", "plans", "pro", "free", "tier", "subscription", "how much", "limits"],
    question: "What plans does TaskPilot offer?",
    answer:
      "TaskPilot offers Free and Pro plans:\n\n- Free Plan (Current): ₹0. Everyone currently has the Free plan limits (1 workspace, 50 tasks per workspace, 5 AI calls/day, 10 agent runs/day).\n- Pro Plan (Future Development): Planned for future development with expanded limits (10 workspaces, 200 tasks per workspace, 200 AI calls/day, 500 agent runs/day, GitHub import).\n\nPlease note: The Pro plan is planned for future development. There is nothing to buy yet, no payments are collected, no card data is requested, and everyone currently has the Free plan limits.",
    followUpChips: ["How do I upgrade to Pro?", "What happens if I hit my quota?", "How do workspaces work?"],
    action: {
      label: "View Plans & Usage",
      type: "open_pricing",
    },
  },
  {
    id: "kb_upgrade",
    topic: "plans_quotas",
    keywords: ["upgrade", "buy", "purchase", "pay", "subscribe", "payment", "card", "billing"],
    question: "How do I upgrade to Pro?",
    answer:
      "The Pro plan is planned for future development. There is nothing to buy yet, no payments are collected, and no card data is requested. Everyone currently has the Free plan limits, and all features are completely free to use right now.",
    followUpChips: ["What plans does TaskPilot offer?", "What happens if I hit my quota?"],
    action: {
      label: "View Plans",
      type: "open_pricing",
    },
  },
  {
    id: "kb_quotas",
    topic: "plans_quotas",
    keywords: ["quota", "limit", "rate limit", "exceeded", "daily", "429", "too many requests"],
    question: "What happens if I hit my daily execution quota?",
    answer:
      "When your daily quota is exhausted, agent runs return an HTTP 429 status code indicating the daily limit has been reached. Quota counters reset automatically every midnight UTC. The Pro plan with higher quotas is planned for future development; currently everyone has the Free plan limits.",
    followUpChips: ["What plans does TaskPilot offer?", "How do workspaces work?"],
    action: {
      label: "Check My Quota Usage",
      type: "open_pricing",
    },
  },
  {
    id: "kb_workspaces",
    topic: "workspaces",
    keywords: ["workspace", "graph", "multi-tenant", "isolation", "new workspace", "switch"],
    question: "How do isolated workspaces work?",
    answer:
      "Every workspace is an isolated environment backed by its own dedicated property graph in FalkorDB and row-level security (RLS) in PostgreSQL.\n\nTasks and graph relationships in one workspace are never visible to or accessible by other users or workspaces.",
    followUpChips: ["Can I create a new workspace?", "What happens when I delete a workspace?"],
    action: {
      label: "Create Workspace",
      type: "open_new_workspace",
    },
  },
  {
    id: "kb_delete_workspace",
    topic: "workspaces",
    keywords: ["delete workspace", "destroy workspace", "remove workspace", "delete", "destroy", "permanently"],
    question: "What happens when I delete a workspace?",
    answer:
      "Deleting a workspace permanently removes the workspace record from PostgreSQL and completely deletes its dedicated graph in FalkorDB. This action is irreversible. The public demo graph named 'taskpilot' is permanently protected and cannot be deleted.",
    followUpChips: ["How do isolated workspaces work?", "How do I add tasks?"],
  },
  {
    id: "kb_guest",
    topic: "account_guest",
    keywords: ["guest", "anonymous", "session", "temporary", "expire", "7 days", "convert"],
    question: "How do guest accounts work?",
    answer:
      "Guest sessions allow you to test TaskPilot instantly without providing credentials. Your data is stored temporarily and automatically cleaned up after 7 days of inactivity.\n\nYou can convert your guest session into a permanent account anytime by clicking 'Create an account' in the top banner or user menu.",
    followUpChips: ["How do I upgrade to a permanent account?", "What happens to my tasks after 7 days?"],
  },
  {
    id: "kb_tasks_cycles",
    topic: "tasks",
    keywords: ["task", "add task", "dependency", "cycle", "circular", "loop", "dag", "deadlock"],
    question: "How does dependency validation and cycle prevention work?",
    answer:
      "When adding tasks with dependencies, TaskPilot runs a depth-first search (3-color DFS) cycle detection algorithm across the graph.\n\nIf adding a dependency would create a circular dependency (e.g. A depends on B which depends on A), the backend rejects it with HTTP 400 'Cycle detected' to guarantee a directed acyclic graph (DAG).",
    followUpChips: ["How do I add a new task?", "What is the task limit per workspace?"],
    action: {
      label: "Add New Task",
      type: "open_new_task",
    },
  },
  {
    id: "kb_security",
    topic: "security",
    keywords: ["security", "jwt", "safe", "token", "rls", "secret", "headers", "csp"],
    question: "What security measures does TaskPilot employ?",
    answer:
      "TaskPilot enforces strict multi-tenant security:\n- Supabase JWT verification on every authenticated request with strict issuer, audience, and algorithm allowlists.\n- Parameterized Cypher queries to eliminate Cypher/SQL injection.\n- PostgreSQL Row-Level Security (RLS) forwarding user tokens.\n- 64KB body size limit to prevent Denial-of-Service attacks.\n- Strict Content Security Policy (CSP) and security headers.",
    followUpChips: ["How do workspaces isolate data?", "Contact Support"],
  },
  {
    id: "kb_contact",
    topic: "contact_support",
    keywords: ["contact", "support", "help", "human", "ticket", "bug", "report", "issue", "assistance", "email"],
    question: "How can I contact human support?",
    answer:
      "If your question is not resolved by our automated assistant, you can submit a support request. Our team will review your message and reply via email within 24 hours.",
    action: {
      label: "Contact Human Support",
      type: "contact_support",
    },
  },
];

export const DEFAULT_SUGGESTIONS = [
  "What plans does TaskPilot offer?",
  "How do I upgrade to Pro?",
  "How do workspaces work?",
  "What happens if I hit my daily quota?",
  "How do guest accounts work?",
  "Contact Human Support",
];

export function findMatchingAnswer(query: string): FAQItem | null {
  const clean = query.trim().toLowerCase();
  if (!clean) return null;

  // 1. Direct question match or exact ID match
  const direct = KNOWLEDGE_BASE.find(
    (item) => item.question.toLowerCase() === clean || item.id === clean
  );
  if (direct) return direct;

  // 2. Score by matching keywords
  const words = clean.split(/[\s,?.!]+/).filter((w) => w.length > 2);
  let bestMatch: FAQItem | null = null;
  let maxScore = 0;

  for (const item of KNOWLEDGE_BASE) {
    let score = 0;
    for (const kw of item.keywords) {
      if (clean.includes(kw.toLowerCase())) {
        score += kw.includes(" ") ? 6 : (kw.length > 4 ? 3 : 2);
      }
    }
    for (const word of words) {
      if (item.question.toLowerCase().includes(word)) {
        score += 1;
      }
    }
    if (score > maxScore) {
      maxScore = score;
      bestMatch = item;
    }
  }

  // Minimum threshold to prevent false positives
  return maxScore >= 2 ? bestMatch : null;
}
