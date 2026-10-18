import React, { useState, useEffect } from "react";
import { Sparkles, Check, X, ShieldAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { getBillingMe } from "@/lib/api";
import { useIsMobile } from "@/hooks/use-mobile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export interface PlanData {
  id: string;
  name: string;
  price_minor?: number;
  amount?: number;
  currency?: string;
  max_workspaces?: number;
  max_tasks_per_workspace?: number;
  daily_ai_runs?: number;
  daily_agent_runs?: number;
  github_import_allowed?: boolean;
}

export function formatPlanPrice(priceMinor?: number, currency?: string): string {
  const minor = priceMinor ?? 0;
  const curr = currency || "INR";
  const amount = minor / 100;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: curr,
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${curr === "INR" ? "₹" : curr} ${amount}`;
  }
}

interface PlanCardsContentProps {
  plans: PlanData[] | null;
  loading: boolean;
  onClose?: () => void;
}

export const PlanCardsContent: React.FC<PlanCardsContentProps> = ({ plans, loading }) => {
  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
        Loading plans...
      </div>
    );
  }

  if (!plans || plans.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground" data-testid="plans-unavailable">
        Plans unavailable right now
      </div>
    );
  }

  const freePlan = plans.find((p) => p.id === "free" || p.name.toLowerCase() === "free") || plans[0];
  const proPlan = plans.find((p) => p.id === "pro" || p.name.toLowerCase() === "pro") || plans[1];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Free Plan Card */}
        {freePlan && (
          <div
            className="flex flex-col justify-between rounded-xl border border-border bg-card p-4 shadow-sm"
            data-testid="plan-card-free"
          >
            <div>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-foreground text-sm">{freePlan.name}</h3>
                <Badge variant="secondary" className="text-[10px] uppercase font-medium">
                  Current plan
                </Badge>
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-2xl font-bold tracking-tight text-foreground">₹0</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Essential graph task reasoning</p>

              <ul className="mt-4 space-y-2 text-xs text-muted-foreground">
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-primary shrink-0" />
                  <span>{freePlan.max_workspaces ?? 1} workspace{(freePlan.max_workspaces ?? 1) > 1 ? "s" : ""}</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-primary shrink-0" />
                  <span>{freePlan.max_tasks_per_workspace ?? 50} tasks per workspace</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-primary shrink-0" />
                  <span>{freePlan.daily_ai_runs ?? 5} AI calls per day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-primary shrink-0" />
                  <span>{freePlan.daily_agent_runs ?? 10} agent runs per day</span>
                </li>
                <li className="flex items-center gap-2">
                  {freePlan.github_import_allowed ? (
                    <Check className="size-3.5 text-primary shrink-0" />
                  ) : (
                    <X className="size-3.5 text-muted-foreground/60 shrink-0" />
                  )}
                  <span>GitHub import: {freePlan.github_import_allowed ? "Yes" : "No"}</span>
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* Pro Plan Card */}
        {proPlan && (
          <div
            className="flex flex-col justify-between rounded-xl border border-indigo-500/30 bg-gradient-to-b from-indigo-500/5 to-transparent p-4 shadow-sm"
            data-testid="plan-card-pro"
          >
            <div>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-foreground text-sm">{proPlan.name}</h3>
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px]"
                >
                  Future development
                </Badge>
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-2xl font-bold tracking-tight text-foreground">
                  {formatPlanPrice(proPlan.price_minor ?? proPlan.amount, proPlan.currency)}
                </span>
                <span className="text-xs text-muted-foreground font-normal"> / month</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">High-capacity automated agents</p>

              <ul className="mt-4 space-y-2 text-xs text-muted-foreground">
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-indigo-500 shrink-0" />
                  <span>{proPlan.max_workspaces ?? 10} workspaces</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-indigo-500 shrink-0" />
                  <span>{proPlan.max_tasks_per_workspace ?? 200} tasks per workspace</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-indigo-500 shrink-0" />
                  <span>{proPlan.daily_ai_runs ?? 200} AI calls per day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-indigo-500 shrink-0" />
                  <span>{proPlan.daily_agent_runs ?? 500} agent runs per day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-indigo-500 shrink-0" />
                  <span>GitHub import: {proPlan.github_import_allowed !== false ? "Yes" : "No"}</span>
                </li>
              </ul>
            </div>

            <Button
              disabled
              variant="outline"
              size="sm"
              className="mt-5 w-full cursor-not-allowed opacity-60 text-xs font-medium"
            >
              Coming soon
            </Button>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground text-center pt-2">
        Paid plans are planned for future development. Everything is free to use right now.
      </p>
    </div>
  );
};

export const PlanChip: React.FC = () => {
  const { user, isGuest } = useAuth();
  const [plans, setPlans] = useState<PlanData[] | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [currentPlanName, setCurrentPlanName] = useState<string>("Free");
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();

  // 1. Resolve user's current plan name
  useEffect(() => {
    if (!user || isGuest) {
      setCurrentPlanName("Free");
      return;
    }
    let mounted = true;
    getBillingMe()
      .then((res) => {
        if (mounted && res?.plan?.name) {
          setCurrentPlanName(res.plan.name);
        }
      })
      .catch(() => {
        if (mounted) setCurrentPlanName("Free");
      });
    return () => {
      mounted = false;
    };
  }, [user, isGuest]);

  // 2. Fetch plans from Supabase anon client
  useEffect(() => {
    if (!open) return;
    let mounted = true;
    setPlanLoading(true);

    supabase
      .from("plans")
      .select("*")
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error || !data || data.length === 0) {
          setPlans(null);
        } else {
          setPlans(data as PlanData[]);
        }
        setPlanLoading(false);
      })
      .catch(() => {
        if (!mounted) return;
        setPlans(null);
        setPlanLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [open]);

  const chipButton = (
    <button
      type="button"
      data-testid="plan-chip"
      aria-label={`Current plan: ${currentPlanName}. View plans`}
      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/70 bg-secondary/60 px-2.5 text-xs font-medium text-foreground transition-all hover:bg-secondary hover:border-border active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Sparkles className="size-3 text-primary shrink-0" />
      <span className="hidden sm:inline text-muted-foreground font-normal">Plan:</span>
      <span className="font-semibold">{currentPlanName}</span>
    </button>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{chipButton}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="w-full max-h-[90vh] overflow-y-auto rounded-t-2xl p-6"
        >
          <SheetHeader className="pb-3 text-left">
            <SheetTitle className="text-base font-semibold">Subscription Plans</SheetTitle>
          </SheetHeader>
          <PlanCardsContent plans={plans} loading={planLoading} onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{chipButton}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[540px] max-w-[95vw] p-5 shadow-xl border bg-card text-card-foreground rounded-xl"
      >
        <div className="mb-3 flex items-center justify-between border-b pb-2">
          <span className="text-sm font-semibold text-foreground">TaskPilot Plans</span>
          <span className="text-xs text-muted-foreground">Future Development</span>
        </div>
        <PlanCardsContent plans={plans} loading={planLoading} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
};
