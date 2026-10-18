import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect, useRef, type FormEvent } from "react";
import { toast } from "sonner";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Moon,
  ShieldCheck,
  Sparkles,
  Sun,
  User,
  UserCheck,
  HelpCircle,
  AlertTriangle,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "error-callback"?: () => void;
          "expired-callback"?: () => void;
        }
      ) => string;
      reset: (widgetId: string) => void;
    };
  }
}

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign In — TaskPilot AI" },
      { name: "description", content: "Sign in to TaskPilot AI, create an account, or continue as guest to manage approval-gated project workflows." },
    ],
  }),
  component: LoginPage,
});

function calculatePasswordStrength(pass: string): { label: string; percent: number; color: string } {
  if (!pass) return { label: "", percent: 0, color: "" };
  let score = 0;
  if (pass.length >= 8) score += 1;
  if (pass.length >= 12) score += 1;
  if (/[A-Z]/.test(pass) && /[a-z]/.test(pass)) score += 1;
  if (/\d/.test(pass)) score += 1;
  if (/[^A-Za-z0-9]/.test(pass)) score += 1;

  if (score <= 2) return { label: "Weak (add letters, numbers & symbols)", percent: 30, color: "bg-danger" };
  if (score <= 4) return { label: "Medium (good length and variety)", percent: 70, color: "bg-warning" };
  return { label: "Strong password", percent: 100, color: "bg-success" };
}

function LoginPage() {
  const navigate = useNavigate();
  const { user, signInWithEmail, signUpWithEmail, signInAsGuest, resetPassword, setDemoMode } = useAuth();

  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const [confirmNotice, setConfirmNotice] = useState<string | null>(null);

  // Forgot password dialog
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  // Turnstile state
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() || "";
  const autoGuest = import.meta.env.VITE_AUTO_GUEST === "true";
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetId = useRef<string | null>(null);

  const [dark, setDark] = useState(() => {
    if (typeof window !== "undefined") {
      return document.documentElement.classList.contains("dark");
    }
    return false;
  });

  const toggleTheme = () => {
    setDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      return next;
    });
  };

  // If already logged in, redirect to home
  useEffect(() => {
    if (user) {
      navigate({ to: "/" });
    }
  }, [user, navigate]);

  // Dynamically load Cloudflare Turnstile script only on this auth screen
  useEffect(() => {
    if (!turnstileSiteKey) return;

    const scriptId = "cloudflare-turnstile-script";
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }

    const interval = setInterval(() => {
      if (window.turnstile && turnstileContainerRef.current && !turnstileWidgetId.current) {
        try {
          turnstileWidgetId.current = window.turnstile.render(turnstileContainerRef.current, {
            sitekey: turnstileSiteKey,
            callback: (token: string) => {
              setTurnstileToken(token);
            },
            "error-callback": () => {
              setTurnstileToken(null);
            },
            "expired-callback": () => {
              setTurnstileToken(null);
            },
          });
        } catch {
          // Ignore render retry error
        }
      }
    }, 300);

    return () => {
      clearInterval(interval);
    };
  }, [turnstileSiteKey]);

  // Handle auto-guest if VITE_AUTO_GUEST=true
  useEffect(() => {
    if (!autoGuest || user) return;

    if (turnstileSiteKey) {
      if (turnstileToken && !guestLoading) {
        setGuestLoading(true);
        signInAsGuest(turnstileToken)
          .then((res) => {
            if (res.success) {
              navigate({ to: "/" });
            }
          })
          .finally(() => setGuestLoading(false));
      }
    } else {
      setGuestLoading(true);
      signInAsGuest()
        .then((res) => {
          if (res.success) {
            navigate({ to: "/" });
          }
        })
        .finally(() => setGuestLoading(false));
    }
  }, [autoGuest, turnstileToken, turnstileSiteKey, user, navigate]);

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      toast.error("Please enter both email and password.");
      return;
    }

    setSubmitting(true);
    setConfirmNotice(null);
    try {
      const res = await signInWithEmail(email, password);
      if (res.success) {
        toast.success("Welcome back!");
        navigate({ to: "/" });
      } else {
        toast.error(res.error || "Invalid login credentials. Please try again.");
      }
    } catch {
      toast.error("Unable to sign in. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      toast.error("Please enter an email and password.");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters long.");
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      toast.error("Please complete the security check.");
      return;
    }

    setSubmitting(true);
    setConfirmNotice(null);
    try {
      const res = await signUpWithEmail(
        email,
        password,
        displayName.trim() || email.split("@")[0],
        turnstileToken || undefined,
      );
      if (res.success) {
        if (res.message) {
          setConfirmNotice(res.message);
          toast.success("Account created! Please check your email to confirm.");
        } else {
          toast.success("Account created successfully!");
          navigate({ to: "/" });
        }
      } else {
        toast.error(res.error || "Could not complete account creation.");
      }
    } catch {
      toast.error("An unexpected error occurred. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleGuestSignIn = async () => {
    if (turnstileSiteKey && !turnstileToken) {
      toast.error("Please complete the security check before continuing as guest.");
      return;
    }
    setGuestLoading(true);
    try {
      const res = await signInAsGuest(turnstileToken || undefined);
      if (res.success) {
        toast.success("Entered as guest operator. Workspaces expire in 7 days unless upgraded.");
        navigate({ to: "/" });
      } else {
        toast.error(res.error || "Failed to create guest session.");
      }
    } catch {
      toast.error("Could not sign in as guest.");
    } finally {
      setGuestLoading(false);
    }
  };

  const handleDemoAccess = () => {
    setDemoMode(true);
    toast.info("Browsing read-only public demo.");
    navigate({ to: "/" });
  };

  const handleForgotPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!forgotEmail.trim()) {
      toast.error("Please enter your email address.");
      return;
    }
    setForgotSubmitting(true);
    try {
      await resetPassword(forgotEmail);
      setForgotSent(true);
    } catch {
      setForgotSent(true);
    } finally {
      setForgotSubmitting(false);
    }
  };

  const strength = calculatePasswordStrength(password);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12 transition-colors">
      {/* Background Accent Gradients */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-[30%] left-1/2 -z-10 h-[500px] w-[600px] -translate-x-1/2 rounded-full bg-primary/10 blur-[120px]" />
        <div className="absolute -bottom-[20%] right-1/4 -z-10 h-[400px] w-[500px] rounded-full bg-accent/20 blur-[100px]" />
      </div>

      {/* Top Bar with Brand & Theme Toggle */}
      <div className="absolute top-4 flex w-full max-w-5xl items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-85">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
            <Activity className="size-4" strokeWidth={2.2} />
          </div>
          <div>
            <span className="text-sm font-bold tracking-tight text-foreground">TaskPilot</span>
            <span className="ml-1 text-[11px] font-medium text-muted-foreground">AI</span>
          </div>
        </Link>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          className="size-9 rounded-full text-muted-foreground hover:text-foreground"
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        >
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </div>

      {/* Main Authentication Card */}
      <Card className="w-full max-w-[440px] border-border/80 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-card/90">
        <CardHeader className="space-y-1.5 pb-4 text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="size-6" strokeWidth={2} />
          </div>
          <CardTitle className="text-xl font-bold tracking-tight">
            {tab === "signin" ? "Sign in to TaskPilot" : "Create your account"}
          </CardTitle>
          <CardDescription className="text-xs">
            {tab === "signin"
              ? "Access your project workspaces and graph automation tools."
              : "Create an account to keep your workspaces permanently."}
          </CardDescription>

          {/* Mode Switch Tabs */}
          <div className="mt-4 flex rounded-lg border bg-muted/60 p-1">
            <button
              type="button"
              onClick={() => { setTab("signin"); setConfirmNotice(null); }}
              className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition-all ${
                tab === "signin" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => { setTab("signup"); setConfirmNotice(null); }}
              className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition-all ${
                tab === "signup" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Create Account
            </button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 pt-0">
          {confirmNotice && (
            <div className="rounded-md border border-primary/20 bg-primary/10 p-3 text-xs text-primary">
              <p className="font-semibold">{confirmNotice}</p>
            </div>
          )}

          {tab === "signin" ? (
            /* --- SIGN IN FORM --- */
            <form onSubmit={handleSignIn} className="space-y-3.5">
              <div className="space-y-1.5">
                <Label htmlFor="signin-email" className="text-xs font-medium">Email address</Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="signin-email"
                    type="email"
                    autoComplete="email"
                    required
                    disabled={submitting}
                    placeholder="name@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-9 pl-9 text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="signin-password" className="text-xs font-medium">Password</Label>
                  <button
                    type="button"
                    onClick={() => { setForgotOpen(true); setForgotSent(false); setForgotEmail(email); }}
                    className="text-[11px] text-primary underline-offset-4 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="signin-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    disabled={submitting}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-9 pl-9 pr-9 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <Button type="submit" className="w-full text-xs" disabled={submitting}>
                {submitting ? "Signing in…" : "Sign In"}
              </Button>
            </form>
          ) : (
            /* --- CREATE ACCOUNT FORM --- */
            <form onSubmit={handleSignUp} className="space-y-3.5">
              <div className="space-y-1.5">
                <Label htmlFor="signup-name" className="text-xs font-medium">Display name</Label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="signup-name"
                    type="text"
                    disabled={submitting}
                    placeholder="Alex Mercer"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="h-9 pl-9 text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="signup-email" className="text-xs font-medium">Email address</Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="signup-email"
                    type="email"
                    autoComplete="email"
                    required
                    disabled={submitting}
                    placeholder="name@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-9 pl-9 text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="signup-password" className="text-xs font-medium">Password</Label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="signup-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    required
                    disabled={submitting}
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-9 pl-9 pr-9 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>

                {password && (
                  <div className="space-y-1 pt-1">
                    <div className="h-1.5 w-full rounded-full bg-secondary">
                      <div className={`h-full rounded-full transition-all ${strength.color}`} style={{ width: `${strength.percent}%` }} />
                    </div>
                    <p className="text-[10px] text-muted-foreground">{strength.label}</p>
                  </div>
                )}
              </div>

              {/* Turnstile Container */}
              {turnstileSiteKey && (
                <div className="flex justify-center py-1">
                  <div ref={turnstileContainerRef} id="turnstile-container" />
                </div>
              )}

              <Button type="submit" className="w-full text-xs" disabled={submitting}>
                {submitting ? "Creating account…" : "Create Account"}
              </Button>
            </form>
          )}

          {/* Turnstile for Guest mode if configured */}
          {tab === "signin" && turnstileSiteKey && (
            <div className="flex justify-center py-1">
              <div ref={turnstileContainerRef} id="turnstile-container" />
            </div>
          )}

          <div className="relative py-2">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-[10px] uppercase">
              <span className="bg-card px-2 text-muted-foreground">Or explore directly</span>
            </div>
          </div>

          {/* Guest Action */}
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2 border-border/80 text-xs font-medium"
            disabled={guestLoading || submitting}
            onClick={handleGuestSignIn}
          >
            <UserCheck className="size-4 text-primary" />
            <span>{guestLoading ? "Connecting as guest…" : "Continue as guest"}</span>
          </Button>
          <p className="text-center text-[10px] text-muted-foreground">
            Guest sessions get their own isolated workspace. Guest data is cleaned after about 7 days.
          </p>
        </CardContent>

        <CardFooter className="flex flex-col border-t bg-muted/20 py-3 text-center">
          <button
            type="button"
            onClick={handleDemoAccess}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary underline-offset-4 hover:underline"
          >
            <span>Just look at the demo (no sign in needed)</span>
            <ArrowRight className="size-3" />
          </button>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Opens the public read-only synthetic graph.
          </p>
        </CardFooter>
      </Card>

      {/* Forgot Password Modal */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset your password</DialogTitle>
            <DialogDescription className="text-xs">
              Enter your email address and we'll send you instructions to reset your password.
            </DialogDescription>
          </DialogHeader>

          {forgotSent ? (
            <div className="space-y-4 py-3 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-success-soft text-success">
                <CheckCircle2 className="size-5" />
              </div>
              <p className="text-xs text-muted-foreground">
                If an account exists with that email address, a password reset link has been dispatched.
              </p>
              <Button onClick={() => setForgotOpen(false)} className="w-full text-xs">
                Back to Sign In
              </Button>
            </div>
          ) : (
            <form onSubmit={handleForgotPassword} className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="forgot-email" className="text-xs">Email address</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  required
                  placeholder="name@example.com"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setForgotOpen(false)} className="text-xs">
                  Cancel
                </Button>
                <Button type="submit" disabled={forgotSubmitting} className="text-xs">
                  {forgotSubmitting ? "Sending…" : "Send Reset Link"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
