import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
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
} from "lucide-react";
import { useAuth, DEMO_USER } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign In — TaskPilot AI" },
      { name: "description", content: "Sign in to TaskPilot AI or continue as guest to explore approval-gated task automation." },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { loginWithEmail, loginAsGuest } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
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

  const handleEmailLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error("Please enter your email address.");
      return;
    }
    if (!password) {
      toast.error("Please enter your password.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await loginWithEmail(email, password, remember);
      if (res.success) {
        toast.success(`Welcome back! Signed in as ${email}`);
        navigate({ to: "/" });
      } else {
        toast.error(res.error || "Authentication failed. Try again.");
      }
    } catch {
      toast.error("An unexpected error occurred during sign in.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleGuestLogin = () => {
    setGuestLoading(true);
    setTimeout(() => {
      loginAsGuest();
      toast.success("Welcome! Exploring as Guest Operator (Full Demo Access)");
      navigate({ to: "/" });
      setGuestLoading(false);
    }, 300);
  };

  const fillDemoCredentials = () => {
    setEmail(DEMO_USER.email);
    setPassword("DemoOperator2026!");
    toast.info("Demo operator credentials filled!");
  };

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-background text-foreground overflow-x-hidden">
      {/* Decorative background glow elements */}
      <div className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-primary/10 dark:bg-primary/20 rounded-full blur-[120px] -z-10" />
      <div className="pointer-events-none absolute -bottom-40 right-10 w-[500px] h-[350px] bg-accent/20 dark:bg-accent/15 rounded-full blur-[100px] -z-10" />

      {/* Top action bar: Brand & Theme switch */}
      <header className="w-full max-w-[460px] flex items-center justify-between mb-6">
        <Link
          to="/"
          className="group flex items-center gap-2.5 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg p-1"
        >
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md shadow-primary/25 transition-transform group-hover:scale-105">
            <Activity className="size-5" strokeWidth={2.2} />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-base tracking-tight">TaskPilot AI</span>
              <Badge variant="outline" className="text-[10px] font-mono font-medium px-1.5 py-0">
                v2.4
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground leading-none">Approval-gated agent console</p>
          </div>
        </Link>

        <Button
          variant="outline"
          size="icon"
          onClick={toggleTheme}
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          className="size-9 rounded-full border-border/80 bg-background/80 backdrop-blur"
        >
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </header>

      {/* Main Login Card */}
      <Card className="w-full max-w-[460px] border-border/70 bg-card/90 backdrop-blur-xl shadow-xl shadow-black/5 dark:shadow-black/20">
        <CardHeader className="space-y-1 pb-4">
          <CardTitle className="text-2xl font-bold tracking-tight">Sign in to your account</CardTitle>
          <CardDescription className="text-sm text-muted-foreground">
            Select your preferred method to access the operator workspace.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {/* Guest User Option Card */}
          <div className="relative overflow-hidden rounded-xl border-2 border-primary/25 bg-primary/[0.04] p-4 transition-all hover:border-primary/45 hover:bg-primary/[0.07] dark:bg-primary/[0.06]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <UserCheck className="size-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Guest User Access</span>
                    <Badge variant="secondary" className="bg-primary/10 text-primary border-primary/20 text-[10px] font-medium">
                      Instant Access
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Explore without credentials. Try tasks, graph analysis, and approvals in full demo mode.
                  </p>
                </div>
              </div>
            </div>

            <Button
              type="button"
              variant="default"
              onClick={handleGuestLogin}
              disabled={guestLoading}
              className="mt-3.5 w-full h-10 font-medium bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
            >
              {guestLoading ? (
                <span className="flex items-center gap-2">
                  <Activity className="size-4 animate-spin" /> Preparing guest workspace...
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <Sparkles className="size-4" /> Continue as Guest User
                </span>
              )}
            </Button>
          </div>

          {/* Divider */}
          <div className="relative flex items-center justify-center">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <span className="relative bg-card px-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">
              or sign in with email
            </span>
          </div>

          {/* Email / Password Form */}
          <form onSubmit={handleEmailLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-xs font-medium">
                Work Email
              </Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-9 h-10 text-sm"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-xs font-medium">
                  Password
                </Label>
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-9 pr-10 h-10 text-sm"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:outline-none"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="remember"
                  checked={remember}
                  onCheckedChange={(checked) => setRemember(!!checked)}
                />
                <Label htmlFor="remember" className="text-xs font-normal text-muted-foreground cursor-pointer">
                  Remember this device
                </Label>
              </div>

              <button
                type="button"
                onClick={fillDemoCredentials}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                title="Prefill sample login credentials"
              >
                <KeyRound className="size-3" /> Auto-fill demo
              </button>
            </div>

            <Button
              type="submit"
              disabled={submitting}
              className="w-full h-10 font-medium gap-2 bg-foreground text-background hover:bg-foreground/90 transition-all"
            >
              {submitting ? (
                <span className="flex items-center gap-2">
                  <Activity className="size-4 animate-spin" /> Verifying...
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  Sign In <ArrowRight className="size-4" />
                </span>
              )}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="flex flex-col gap-3 border-t bg-muted/20 px-6 py-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 text-emerald-500 shrink-0" />
            <span>Human-in-the-loop approvals safeguard all automated actions.</span>
          </div>
          <div className="text-center">
            <Link
              to="/"
              className="text-xs text-muted-foreground hover:text-primary transition-colors underline-offset-4 hover:underline"
            >
              ← Back to TaskPilot Console
            </Link>
          </div>
        </CardFooter>
      </Card>

      {/* Forgot Password Dialog */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-primary" /> Password Assistance
            </DialogTitle>
            <DialogDescription className="pt-2 text-sm text-muted-foreground space-y-2">
              <p>
                In this environment, you can sign in instantly using the demo credentials or the Guest User mode:
              </p>
              <div className="rounded-lg border bg-muted/40 p-3 font-mono text-xs space-y-1">
                <div><span className="text-muted-foreground">Demo Email:</span> {DEMO_USER.email}</div>
                <div><span className="text-muted-foreground">Demo Password:</span> DemoOperator2026!</div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                fillDemoCredentials();
                setForgotOpen(false);
              }}
            >
              Fill Demo Credentials
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setForgotOpen(false);
                handleGuestLogin();
              }}
            >
              Sign In as Guest
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
