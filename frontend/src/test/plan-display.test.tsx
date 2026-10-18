import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanChip, PlanCardsContent, formatPlanPrice, PlanData } from "../components/taskpilot/PlanDisplay";
import * as authModule from "../lib/auth";
import * as apiModule from "../lib/api";
import { supabase } from "../lib/supabase";

const mockPlans: PlanData[] = [
  {
    id: "free",
    name: "Free",
    price_minor: 0,
    currency: "INR",
    max_workspaces: 1,
    max_tasks_per_workspace: 50,
    daily_ai_runs: 5,
    daily_agent_runs: 10,
    github_import_allowed: false,
  },
  {
    id: "pro",
    name: "Pro",
    price_minor: 19900,
    currency: "INR",
    max_workspaces: 10,
    max_tasks_per_workspace: 200,
    daily_ai_runs: 200,
    daily_agent_runs: 500,
    github_import_allowed: true,
  },
];

describe("Plan Display Component", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Price formatting", () => {
    it("formats price_minor divided by 100 with Intl.NumberFormat", () => {
      // 19900 paise = 199 INR
      const formatted = formatPlanPrice(19900, "INR");
      expect(formatted).toContain("199");
      expect(formatted).toMatch(/₹|INR/);

      // 0 paise = 0 INR
      const freeFormatted = formatPlanPrice(0, "INR");
      expect(freeFormatted).toContain("0");

      // Custom currency USD
      const usdFormatted = formatPlanPrice(1500, "USD");
      expect(usdFormatted).toContain("15");
    });
  });

  describe("Plan Chip Rendering", () => {
    it("renders 'Free' for logged-out / anonymous demo visitors", async () => {
      vi.spyOn(authModule, "useAuth").mockReturnValue({
        user: null,
        session: null,
        loading: false,
        isGuest: false,
        signIn: vi.fn(),
        signUp: vi.fn(),
        signInGuest: vi.fn(),
        upgradeGuest: vi.fn(),
        requestPasswordReset: vi.fn(),
        signOut: vi.fn(),
      });

      render(<PlanChip />);
      const chip = screen.getByTestId("plan-chip");
      expect(chip).toBeInTheDocument();
      expect(chip).toHaveTextContent("Free");
    });

    it("renders 'Free' for guest users", async () => {
      vi.spyOn(authModule, "useAuth").mockReturnValue({
        user: { id: "guest-1", email: "", name: "Guest User", isGuest: true },
        session: null,
        loading: false,
        isGuest: true,
        signIn: vi.fn(),
        signUp: vi.fn(),
        signInGuest: vi.fn(),
        upgradeGuest: vi.fn(),
        requestPasswordReset: vi.fn(),
        signOut: vi.fn(),
      });

      render(<PlanChip />);
      const chip = screen.getByTestId("plan-chip");
      expect(chip).toBeInTheDocument();
      expect(chip).toHaveTextContent("Free");
    });

    it("renders user plan name from getBillingMe for signed-in users", async () => {
      vi.spyOn(authModule, "useAuth").mockReturnValue({
        user: { id: "user-123", email: "pro@example.com", name: "Pro User", isGuest: false },
        session: null,
        loading: false,
        isGuest: false,
        signIn: vi.fn(),
        signUp: vi.fn(),
        signInGuest: vi.fn(),
        upgradeGuest: vi.fn(),
        requestPasswordReset: vi.fn(),
        signOut: vi.fn(),
      });

      vi.spyOn(apiModule, "getBillingMe").mockResolvedValueOnce({
        plan_id: "pro",
        plan: {
          id: "pro",
          name: "Pro",
          amount: 19900,
          currency: "INR",
          daily_agent_runs: 500,
          daily_ai_runs: 200,
          max_tasks_per_workspace: 200,
          github_import_allowed: true,
          max_workspaces: 10,
        },
        limits: {
          id: "pro",
          name: "Pro",
          amount: 19900,
          currency: "INR",
          daily_agent_runs: 500,
          daily_ai_runs: 200,
          max_tasks_per_workspace: 200,
          github_import_allowed: true,
          max_workspaces: 10,
        },
        usage_today: { agent_runs: 2, ai_runs: 1 },
      });

      render(<PlanChip />);
      await waitFor(() => {
        const chip = screen.getByTestId("plan-chip");
        expect(chip).toHaveTextContent("Pro");
      });
    });
  });

  describe("Plan Cards Content & Popover", () => {
    it("renders both Free and Pro cards with limits, badge, and disabled Coming Soon button", () => {
      render(<PlanCardsContent plans={mockPlans} loading={false} />);

      // Free Card
      const freeCard = screen.getByTestId("plan-card-free");
      expect(freeCard).toBeInTheDocument();
      expect(freeCard).toHaveTextContent("₹0");
      expect(freeCard).toHaveTextContent("Current plan");
      expect(freeCard).toHaveTextContent("1 workspace");
      expect(freeCard).toHaveTextContent("50 tasks per workspace");
      expect(freeCard).toHaveTextContent("5 AI calls per day");
      expect(freeCard).toHaveTextContent("10 agent runs per day");
      expect(freeCard).toHaveTextContent("GitHub import: No");

      // Pro Card
      const proCard = screen.getByTestId("plan-card-pro");
      expect(proCard).toBeInTheDocument();
      expect(proCard).toHaveTextContent("199");
      expect(proCard).toHaveTextContent("/ month");
      expect(proCard).toHaveTextContent("Future development");
      expect(proCard).toHaveTextContent("10 workspaces");
      expect(proCard).toHaveTextContent("200 tasks per workspace");
      expect(proCard).toHaveTextContent("200 AI calls per day");
      expect(proCard).toHaveTextContent("500 agent runs per day");
      expect(proCard).toHaveTextContent("GitHub import: Yes");

      // Disabled "Coming soon" button
      const comingSoonBtn = screen.getByRole("button", { name: /coming soon/i });
      expect(comingSoonBtn).toBeInTheDocument();
      expect(comingSoonBtn).toBeDisabled();

      // Exact muted text under both cards
      expect(
        screen.getByText("Paid plans are planned for future development. Everything is free to use right now.")
      ).toBeInTheDocument();
    });

    it("renders fallback message 'Plans unavailable right now' when plans fail to load", () => {
      render(<PlanCardsContent plans={null} loading={false} />);

      const fallback = screen.getByTestId("plans-unavailable");
      expect(fallback).toBeInTheDocument();
      expect(fallback).toHaveTextContent("Plans unavailable right now");
      // Must not show any prices
      expect(screen.queryByText(/₹0/)).not.toBeInTheDocument();
      expect(screen.queryByText(/month/i)).not.toBeInTheDocument();
    });
  });

  describe("Security: No innerHTML usage", () => {
    it("never sets or renders dangerouslySetInnerHTML in PlanDisplay", () => {
      const { container } = render(<PlanCardsContent plans={mockPlans} loading={false} />);
      expect(container.innerHTML).not.toContain("<script");
      expect(container.innerHTML).not.toContain("dangerouslySetInnerHTML");
    });
  });
});
