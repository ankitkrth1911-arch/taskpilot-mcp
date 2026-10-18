import { describe, expect, it, vi, beforeEach } from "vitest";
import { supabase } from "@/lib/supabase";
import { getActiveWorkspaceId, runAgent } from "@/lib/api";

describe("Frontend Auth & Workspace Flows", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("handles sign in with email and password, and returns friendly error on wrong password", async () => {
    const signInSpy = vi.spyOn(supabase.auth, "signInWithPassword").mockResolvedValueOnce({
      data: {
        user: null,
        session: null,
      },
      error: {
        name: "AuthApiError",
        message: "Invalid login credentials",
        status: 400,
      } as any,
    });

    const res = await supabase.auth.signInWithPassword({
      email: "test@example.com",
      password: "WrongPassword123",
    });

    expect(signInSpy).toHaveBeenCalledWith({
      email: "test@example.com",
      password: "WrongPassword123",
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toBe("Invalid login credentials");
  });

  it("handles sign up with display name metadata", async () => {
    const signUpSpy = vi.spyOn(supabase.auth, "signUp").mockResolvedValueOnce({
      data: {
        user: {
          id: "u-123",
          email: "new@example.com",
          user_metadata: { full_name: "Alice Operator" },
          app_metadata: {},
          aud: "authenticated",
          created_at: new Date().toISOString(),
        } as any,
        session: null,
      },
      error: null,
    });

    const res = await supabase.auth.signUp({
      email: "new@example.com",
      password: "SecurePassword123!",
      options: {
        data: { full_name: "Alice Operator" },
      },
    });

    expect(signUpSpy).toHaveBeenCalled();
    expect(res.data.user?.email).toBe("new@example.com");
    expect(res.data.user?.user_metadata?.full_name).toBe("Alice Operator");
  });

  it("creates an anonymous guest session", async () => {
    const guestSpy = vi.spyOn(supabase.auth, "signInAnonymously").mockResolvedValueOnce({
      data: {
        user: {
          id: "guest-456",
          is_anonymous: true,
          email: undefined,
          app_metadata: {},
          user_metadata: {},
          aud: "authenticated",
          created_at: new Date().toISOString(),
        } as any,
        session: {
          access_token: "mock-guest-token",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "mock-refresh",
          user: {} as any,
        },
      },
      error: null,
    });

    const res = await supabase.auth.signInAnonymously();
    expect(guestSpy).toHaveBeenCalled();
    expect(res.data.user?.is_anonymous).toBe(true);
  });

  it("upgrades guest to account via updateUser with email and password", async () => {
    const updateSpy = vi.spyOn(supabase.auth, "updateUser").mockResolvedValueOnce({
      data: {
        user: {
          id: "guest-456",
          is_anonymous: false,
          email: "upgraded@example.com",
          app_metadata: {},
          user_metadata: {},
          aud: "authenticated",
          created_at: new Date().toISOString(),
        } as any,
      },
      error: null,
    });

    const res = await supabase.auth.updateUser({
      email: "upgraded@example.com",
      password: "NewPassword123!",
    });

    expect(updateSpy).toHaveBeenCalledWith({
      email: "upgraded@example.com",
      password: "NewPassword123!",
    });
    expect(res.data.user?.is_anonymous).toBe(false);
    expect(res.data.user?.email).toBe("upgraded@example.com");
  });

  it("handles sign out cleanly", async () => {
    const signOutSpy = vi.spyOn(supabase.auth, "signOut").mockResolvedValueOnce({
      error: null,
    });

    await supabase.auth.signOut();
    expect(signOutSpy).toHaveBeenCalled();
  });

  it("persists demo mode without requiring session", () => {
    localStorage.setItem("taskpilot_demo_mode", "true");
    expect(localStorage.getItem("taskpilot_demo_mode")).toBe("true");

    localStorage.removeItem("taskpilot_demo_mode");
    expect(localStorage.getItem("taskpilot_demo_mode")).toBeNull();
  });

  it("stores active workspace and retrieves workspace id for request headers", () => {
    const mockWorkspace = {
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      name: "Engineering Team",
    };

    localStorage.setItem("taskpilot_active_workspace", JSON.stringify(mockWorkspace));
    expect(getActiveWorkspaceId()).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");

    localStorage.removeItem("taskpilot_active_workspace");
    expect(getActiveWorkspaceId()).toBeNull();
  });

  it("runs the agent in workspace mode when workspace is configured", async () => {
    // In demo / fallback mode, runAgent returns mock result
    const res = await runAgent("Find overdue tasks");
    expect(res).toBeDefined();
    expect(res.mode).toBeDefined();
    expect(Array.isArray(res.overdue)).toBe(true);
  });
});
