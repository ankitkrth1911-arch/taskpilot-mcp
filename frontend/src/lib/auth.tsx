import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User as SupabaseUser } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./supabase";

export interface User {
  id: string;
  name: string;
  email: string;
  isGuest: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  graph_name?: string;
  created_at?: string;
  expires_at?: string;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isGuest: boolean;
  isDemo: boolean;
  loading: boolean;
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  guestBannerDismissed: boolean;
  setDemoMode: (enabled: boolean) => void;
  signInWithEmail: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signUpWithEmail: (email: string, password: string, displayName: string, captchaToken?: string) => Promise<{ success: boolean; error?: string; message?: string }>;
  signInAsGuest: (captchaToken?: string) => Promise<{ success: boolean; error?: string }>;
  upgradeGuest: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  resetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  signOut: () => Promise<void>;
  setCurrentWorkspace: (ws: Workspace | null) => void;
  refreshWorkspaces: () => Promise<void>;
  dismissGuestBanner: () => void;
}

const DEMO_STORAGE_KEY = "taskpilot_demo_mode";
const WORKSPACE_STORAGE_KEY = "taskpilot_active_workspace";
const GUEST_BANNER_KEY = "taskpilot_guest_banner_dismissed";

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function mapSupabaseUser(sbUser: SupabaseUser | undefined | null): User | null {
  if (!sbUser) return null;
  const isGuest = Boolean(sbUser.is_anonymous);
  const fullName = sbUser.user_metadata?.full_name || sbUser.user_metadata?.name || "";
  const email = sbUser.email || (isGuest ? "guest@taskpilot.local" : "");
  const displayName = isGuest ? "Guest Operator" : (fullName || email.split("@")[0] || "Operator");

  return {
    id: sbUser.id,
    name: displayName,
    email,
    isGuest,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDemo, setIsDemo] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(DEMO_STORAGE_KEY) === "true";
  });
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspaceState] = useState<Workspace | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const stored = localStorage.getItem(WORKSPACE_STORAGE_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [guestBannerDismissed, setGuestBannerDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(GUEST_BANNER_KEY) === "true";
  });

  const setDemoMode = (enabled: boolean) => {
    setIsDemo(enabled);
    if (typeof window !== "undefined") {
      if (enabled) {
        localStorage.setItem(DEMO_STORAGE_KEY, "true");
      } else {
        localStorage.removeItem(DEMO_STORAGE_KEY);
      }
    }
  };

  const setCurrentWorkspace = (ws: Workspace | null) => {
    setCurrentWorkspaceState(ws);
    if (typeof window !== "undefined") {
      if (ws) {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
      } else {
        localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      }
    }
  };

  const dismissGuestBanner = () => {
    setGuestBannerDismissed(true);
    if (typeof window !== "undefined") {
      sessionStorage.setItem(GUEST_BANNER_KEY, "true");
    }
  };

  // onAuthStateChange listener
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      setSession(initialSession);
      setUser(mapSupabaseUser(initialSession?.user));
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession);
      setUser(mapSupabaseUser(currentSession?.user));
      setLoading(false);
      if (currentSession) {
        setIsDemo(false);
        if (typeof window !== "undefined") {
          localStorage.removeItem(DEMO_STORAGE_KEY);
        }
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const refreshWorkspaces = async () => {
    if (!session?.access_token) {
      setWorkspaces([]);
      return;
    }
    try {
      const apiBase = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") || "";
      const res = await fetch(`${apiBase}/api/workspaces`, {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setWorkspaces(data);
          // If current workspace was deleted or not in list, fallback
          if (currentWorkspace && !data.some((w) => w.id === currentWorkspace.id)) {
            setCurrentWorkspace(data[0] || null);
          } else if (!currentWorkspace && data.length > 0) {
            setCurrentWorkspace(data[0]);
          }
        }
      }
    } catch {
      // Ignore background refresh errors
    }
  };

  // Re-fetch workspaces when session changes
  useEffect(() => {
    if (session?.access_token) {
      refreshWorkspaces();
    } else {
      setWorkspaces([]);
      setCurrentWorkspace(null);
    }
  }, [session?.access_token]);

  const signInWithEmail = async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      return { success: false, error: "Authentication service not configured. You can use 'Just look at the demo'." };
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      // Do not reveal whether email exists; use friendly generic error
      return { success: false, error: "Invalid email or password. Please try again." };
    }
    setDemoMode(false);
    return { success: true };
  };

  const signUpWithEmail = async (
    email: string,
    password: string,
    displayName: string,
    captchaToken?: string,
  ) => {
    if (!isSupabaseConfigured) {
      return { success: false, error: "Authentication service not configured. You can use 'Just look at the demo'." };
    }
    const options: { data: { full_name: string }; captchaToken?: string } = {
      data: { full_name: displayName.trim() },
    };
    if (captchaToken) {
      options.captchaToken = captchaToken;
    }
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options,
    });
    if (error) {
      return { success: false, error: error.message || "Could not complete account creation." };
    }
    setDemoMode(false);
    const needConfirm = !data.session;
    return {
      success: true,
      message: needConfirm ? "Account created! Please check your email to confirm your account." : undefined,
    };
  };

  const signInAsGuest = async (captchaToken?: string) => {
    if (!isSupabaseConfigured) {
      return { success: false, error: "Authentication service not configured. You can use 'Just look at the demo'." };
    }
    const options: { captchaToken?: string } = {};
    if (captchaToken) {
      options.captchaToken = captchaToken;
    }
    const { error } = await supabase.auth.signInAnonymously({ options });
    if (error) {
      return { success: false, error: error.message || "Failed to create guest session." };
    }
    setDemoMode(false);
    return { success: true };
  };

  const upgradeGuest = async (email: string, password: string) => {
    const { error } = await supabase.auth.updateUser({
      email: email.trim(),
      password,
    });
    if (error) {
      return { success: false, error: error.message || "Failed to upgrade guest account." };
    }
    return { success: true };
  };

  const resetPassword = async (email: string) => {
    if (!isSupabaseConfigured) {
      return { success: false, error: "Authentication service not configured." };
    }
    const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/login` : undefined;
    await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    // Generic message to prevent email enumeration
    return { success: true };
  };

  const signOut = async () => {
    setCurrentWorkspace(null);
    setWorkspaces([]);
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        isGuest: Boolean(user?.isGuest),
        isDemo,
        loading,
        currentWorkspace,
        workspaces,
        guestBannerDismissed,
        setDemoMode,
        signInWithEmail,
        signUpWithEmail,
        signInAsGuest,
        upgradeGuest,
        resetPassword,
        signOut,
        setCurrentWorkspace,
        refreshWorkspaces,
        dismissGuestBanner,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
