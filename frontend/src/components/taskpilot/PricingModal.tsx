import React, { useState, useEffect } from "react";
import { X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { PlanData, PlanCardsContent } from "./PlanDisplay";

interface PricingModalProps {
  open: boolean;
  onClose: () => void;
  onOpenUpgradeGuest?: () => void;
}

export const PricingModal: React.FC<PricingModalProps> = ({
  open,
  onClose,
}) => {
  const [plans, setPlans] = useState<PlanData[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    setLoading(true);

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
        setLoading(false);
      })
      .catch(() => {
        if (!mounted) return;
        setPlans(null);
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pricing-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-2xl rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b">
          <div>
            <h2 id="pricing-modal-title" className="text-lg font-bold tracking-tight text-foreground">
              TaskPilot Plans &amp; Limits
            </h2>
            <p className="text-xs text-muted-foreground">
              Overview of available and upcoming service tiers
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5">
          <PlanCardsContent plans={plans} loading={loading} onClose={onClose} />
        </div>

        {/* Footer legal links */}
        <div className="mt-6 border-t border-border pt-4 text-center text-xs text-muted-foreground flex items-center justify-center gap-4">
          <a href="/terms" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Terms of Service
          </a>
          <span>•</span>
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Privacy Policy
          </a>
        </div>
      </div>
    </div>
  );
};
