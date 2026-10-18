import React, { useState, useEffect } from "react";
import { Check, ShieldAlert, Sparkles, X, Loader2, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../../lib/auth";
import {
  getBillingMe,
  createCheckout,
  verifyPayment,
  BillingMeResponse,
} from "../../lib/api";

declare global {
  interface Window {
    Razorpay?: any;
  }
}

interface PricingModalProps {
  open: boolean;
  onClose: () => void;
  onOpenUpgradeGuest?: () => void;
}

export const PricingModal: React.FC<PricingModalProps> = ({
  open,
  onClose,
  onOpenUpgradeGuest,
}) => {
  const { user, isGuest } = useAuth();
  const [billing, setBilling] = useState<BillingMeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);

  const fetchBilling = async () => {
    try {
      setLoading(true);
      const data = await getBillingMe();
      setBilling(data);
    } catch (err: any) {
      console.warn("Could not fetch billing details:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      fetchBilling();
    }
  }, [open]);

  if (!open) return null;

  const loadRazorpayScript = (): Promise<boolean> => {
    return new Promise((resolve) => {
      if (window.Razorpay) {
        resolve(true);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  const handleUpgrade = async () => {
    if (isGuest) {
      toast.error("Please create a permanent account before upgrading to Pro.");
      if (onOpenUpgradeGuest) onOpenUpgradeGuest();
      return;
    }

    try {
      setCheckingOut(true);
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded) {
        toast.error("Failed to load Razorpay payment gateway. Please check your internet connection.");
        return;
      }

      const checkout = await createCheckout("pro");

      const options = {
        key: checkout.keyId,
        amount: checkout.amount,
        currency: checkout.currency,
        name: "TaskPilot AI",
        description: "TaskPilot Pro Subscription (30 Days)",
        order_id: checkout.orderId,
        prefill: {
          email: user?.email || "",
        },
        theme: {
          color: "#4f46e5",
        },
        handler: async (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          try {
            toast.loading("Verifying payment...", { id: "payment-verify" });
            const verifyRes = await verifyPayment(response);
            toast.success(verifyRes.message || "Pro subscription activated!", { id: "payment-verify" });
            await fetchBilling();
          } catch (verifyErr: any) {
            toast.error(verifyErr.message || "Payment verification failed", { id: "payment-verify" });
          }
        },
        modal: {
          ondismiss: () => {
            toast.info("Payment window closed.");
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", (response: any) => {
        toast.error(response.error?.description || "Payment failed");
      });
      rzp.open();
    } catch (err: any) {
      toast.error(err.message || "Failed to start checkout");
    } finally {
      setCheckingOut(false);
    }
  };

  const isPro = billing?.plan_id === "pro";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-3xl rounded-2xl border border-border bg-card p-6 shadow-2xl text-card-foreground max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Close dialog"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Top Banner: TEST MODE */}
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-500 dark:text-amber-400">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span>
            <strong>TEST MODE:</strong> No real money is charged. Uses Razorpay Test Mode with test cards.
          </span>
        </div>

        {/* Header */}
        <div className="mb-6 text-center">
          <h2 className="text-2xl font-bold tracking-tight">Plans &amp; Usage</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your TaskPilot subscription and monitor your daily execution quotas.
          </p>
        </div>

        {/* Current Usage Status */}
        {billing && (
          <div className="mb-6 rounded-xl border border-border/80 bg-muted/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
              <div>
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Current Plan</span>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-base font-semibold capitalize text-foreground">{billing.plan.name}</span>
                  {isPro ? (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-500">
                      Active
                    </span>
                  ) : (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      Free Tier
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Workspaces</span>
                <div className="text-sm font-medium text-foreground">
                  Up to {billing.limits.max_workspaces} workspace{billing.limits.max_workspaces > 1 ? "s" : ""}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Agent Runs (Today)</div>
                <div className="font-semibold text-foreground">
                  {billing.usage_today.agent_runs} / {billing.limits.daily_agent_runs}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">AI Runs (Today)</div>
                <div className="font-semibold text-foreground">
                  {billing.usage_today.ai_runs} / {billing.limits.daily_ai_runs}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Tasks Per Workspace</div>
                <div className="font-semibold text-foreground">
                  Max {billing.limits.max_tasks_per_workspace}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Guest Warning */}
        {isGuest && (
          <div className="mb-6 rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 text-xs text-indigo-300 flex items-center justify-between gap-3">
            <span>
              You are currently using a <strong>Guest Session</strong>. You must link an email before upgrading.
            </span>
            {onOpenUpgradeGuest && (
              <button
                onClick={() => {
                  onClose();
                  onOpenUpgradeGuest();
                }}
                className="shrink-0 font-semibold underline hover:text-white"
              >
                Create Account
              </button>
            )}
          </div>
        )}

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Free Tier */}
          <div className="flex flex-col justify-between rounded-xl border border-border bg-card p-5">
            <div>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-foreground">Free</h3>
                <span className="text-xs font-medium text-muted-foreground">Standard</span>
              </div>
              <div className="mt-3">
                <span className="text-3xl font-extrabold text-foreground">₹0</span>
                <span className="text-xs text-muted-foreground"> / month</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Ideal for exploring TaskPilot and orchestrating smaller personal projects.
              </p>

              <ul className="mt-4 space-y-2 text-xs text-muted-foreground">
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-500" />
                  <span>10 autonomous agent runs / day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-500" />
                  <span>5 LLM reasoning runs / day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-500" />
                  <span>50 tasks per workspace</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-500" />
                  <span>1 workspace</span>
                </li>
                <li className="flex items-center gap-2 opacity-50">
                  <X className="h-4 w-4 text-muted-foreground" />
                  <span>GitHub import locked</span>
                </li>
              </ul>
            </div>

            <button
              disabled
              className="mt-6 w-full rounded-lg border border-border bg-muted/60 py-2 text-xs font-medium text-muted-foreground"
            >
              {!isPro ? "Current Plan" : "Included"}
            </button>
          </div>

          {/* Pro Tier */}
          <div className="relative flex flex-col justify-between rounded-xl border-2 border-indigo-500 bg-card p-5 shadow-lg">
            <div className="absolute -top-3 right-4 rounded-full bg-indigo-600 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
              Recommended
            </div>
            <div>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-foreground flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4 text-indigo-500" />
                  Pro
                </h3>
                <span className="text-xs font-semibold text-indigo-500">Full Power</span>
              </div>
              <div className="mt-3">
                <span className="text-3xl font-extrabold text-foreground">₹999</span>
                <span className="text-xs text-muted-foreground"> / 30 days</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                For power developers, teams, and high-frequency project graph reasoning.
              </p>

              <ul className="mt-4 space-y-2 text-xs text-foreground">
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-indigo-500" />
                  <span><strong>500</strong> autonomous agent runs / day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-indigo-500" />
                  <span><strong>200</strong> LLM reasoning runs / day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-indigo-500" />
                  <span><strong>200</strong> tasks per workspace (cap)</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-indigo-500" />
                  <span><strong>10</strong> isolated workspaces</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-indigo-500" />
                  <span>GitHub repository import enabled</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-indigo-500" />
                  <span>Priority FalkorDB graph execution</span>
                </li>
              </ul>
            </div>

            <button
              onClick={handleUpgrade}
              disabled={checkingOut || isPro || isGuest}
              className={`mt-6 flex items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-semibold text-white transition-all shadow-md ${
                isPro
                  ? "bg-emerald-600 cursor-default"
                  : isGuest
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98]"
              }`}
            >
              {checkingOut ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Preparing Test Checkout...
                </>
              ) : isPro ? (
                "Active Subscription"
              ) : isGuest ? (
                "Create Account to Upgrade"
              ) : (
                <>
                  Upgrade to Pro
                  <ArrowUpRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </div>

        {/* Footer legal links */}
        <div className="mt-6 border-t border-border/80 pt-4 text-center text-xs text-muted-foreground flex items-center justify-center gap-4">
          <a href="/terms" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Terms of Service
          </a>
          <span>•</span>
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Privacy Policy
          </a>
          <span>•</span>
          <a href="/refund" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Refund Policy
          </a>
        </div>
      </div>
    </div>
  );
};
