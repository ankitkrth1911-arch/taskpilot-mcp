import { describe, it, expect } from "vitest";
import { findMatchingAnswer, KNOWLEDGE_BASE } from "../chatbot/kb";

describe("Rule-based Help Chatbot Knowledge Base", () => {
  it("matches pricing queries accurately", () => {
    const match = findMatchingAnswer("How much does the Pro plan cost?");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("kb_plans");
    expect(match?.answer).toContain("₹999");
  });

  it("matches upgrade queries accurately", () => {
    const match = findMatchingAnswer("How do I upgrade to Pro?");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("kb_upgrade");
    expect(match?.action?.type).toBe("open_pricing");
  });

  it("matches quota exhaustion queries", () => {
    const match = findMatchingAnswer("I got a 429 daily rate limit quota error");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("kb_quotas");
    expect(match?.answer).toContain("429");
  });

  it("matches workspace isolation queries", () => {
    const match = findMatchingAnswer("How do isolated workspaces work?");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("kb_workspaces");
    expect(match?.answer).toContain("FalkorDB");
  });

  it("matches workspace deletion queries", () => {
    const match = findMatchingAnswer("delete workspace permanently");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("kb_delete_workspace");
    expect(match?.answer).toContain("taskpilot");
  });

  it("matches guest account queries", () => {
    const match = findMatchingAnswer("how do guest sessions expire after 7 days?");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("kb_guest");
    expect(match?.answer).toContain("7 days");
  });

  it("matches dependency cycle questions", () => {
    const match = findMatchingAnswer("What happens if there is a circular dependency cycle?");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("kb_tasks_cycles");
    expect(match?.answer).toContain("DFS");
  });

  it("matches security questions", () => {
    const match = findMatchingAnswer("Is my data safe with JWT and RLS?");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("kb_security");
    expect(match?.answer).toContain("Row-Level Security");
  });

  it("matches contact support questions", () => {
    const match = findMatchingAnswer("Can I contact human support for assistance?");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("kb_contact");
    expect(match?.action?.type).toBe("contact_support");
  });

  it("returns null for unrecognized queries allowing fallback", () => {
    const match = findMatchingAnswer("xylophone quantum banana astrophysics");
    expect(match).toBeNull();
  });

  it("guarantees all knowledge base answers are pure plain text without HTML tags", () => {
    const htmlRegex = /<\/?[a-z][\s\S]*>/i;
    for (const item of KNOWLEDGE_BASE) {
      expect(htmlRegex.test(item.answer)).toBe(false);
      expect(item.answer).not.toContain("<script");
      expect(item.answer).not.toContain("<iframe");
    }
  });
});
