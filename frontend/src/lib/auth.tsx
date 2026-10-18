import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar?: string;
  isGuest: boolean;
}

export const GUEST_USER: User = {
  id: "guest-user",
  name: "Guest Operator",
  email: "guest@taskpilot.ai",
  role: "Guest Demo",
  isGuest: true,
};

export const DEMO_USER: User = {
  id: "operator-1",
  name: "Alex Mercer",
  email: "operator@taskpilot.ai",
  role: "Lead Automation Operator",
  isGuest: false,
};

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  loginWithEmail: (email: string, password?: string, remember?: boolean) => Promise<{ success: boolean; error?: string }>;
  loginAsGuest: () => void;
  logout: () => void;
}

const STORAGE_KEY = "taskpilot_auth_user";

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    if (typeof window === "undefined") return GUEST_USER;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored) as User;
      }
    } catch {
      // Ignore localStorage errors
    }
    // Default to Guest user so the app is immediately usable
    return GUEST_USER;
  });

  const saveUser = (newUser: User | null, remember = true) => {
    setUser(newUser);
    if (typeof window !== "undefined") {
      try {
        if (newUser && remember) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(newUser));
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        // Ignore localStorage errors
      }
    }
  };

  const loginWithEmail = async (email: string, _password?: string, remember = true) => {
    // Simulated auth delay for realistic UX
    await new Promise((r) => setTimeout(r, 400));

    if (!email || !email.includes("@")) {
      return { success: false, error: "Please enter a valid email address." };
    }

    const trimmed = email.trim();
    const isDemo = trimmed.toLowerCase() === DEMO_USER.email.toLowerCase();

    const loggedInUser: User = {
      id: isDemo ? DEMO_USER.id : `usr-${Date.now()}`,
      name: isDemo ? DEMO_USER.name : trimmed.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      email: trimmed,
      role: isDemo ? DEMO_USER.role : "Verified Operator",
      isGuest: false,
    };

    saveUser(loggedInUser, remember);
    return { success: true };
  };

  const loginAsGuest = () => {
    saveUser(GUEST_USER, true);
  };

  const logout = () => {
    saveUser(null, false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        loginWithEmail,
        loginAsGuest,
        logout,
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
