import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/refund")({
  component: RefundPage,
});

function RefundPage() {
  return (
    <div className="min-h-screen bg-background text-foreground py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>

        {/* Legal Review Banner */}
        <div className="mb-8 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-500 dark:text-amber-400">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="text-sm">
            <strong className="block font-semibold">NEEDS LEGAL REVIEW - PLACEHOLDER ONLY</strong>
            This refund and cancellation policy document is a template provided for test and preview purposes. It has not been reviewed by legal counsel.
          </div>
        </div>

        <h1 className="text-3xl font-extrabold tracking-tight">Refund &amp; Cancellation Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: October 2026</p>

        <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="text-base font-semibold text-foreground">1. Subscription Cancellations</h2>
            <p className="mt-1">
              You can cancel your TaskPilot Pro subscription at any time through the Account &amp; Billing settings. Cancellation takes effect at the end of the current 30-day billing period.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">2. Refund Requests</h2>
            <p className="mt-1">
              If you experience technical issues that prevent you from utilizing your Pro quotas, you may contact support within 7 days of purchase for a review and potential refund.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">3. Test Mode Notice</h2>
            <p className="mt-1">
              Please note that transactions made in Razorpay Test Mode do not represent real financial transactions and cannot be refunded as no real currency was transferred.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
