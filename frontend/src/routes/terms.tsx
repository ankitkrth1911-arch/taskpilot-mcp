import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/terms")({
  component: TermsPage,
});

function TermsPage() {
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
            This terms of service document is a template provided for test and preview purposes. It has not been reviewed by legal counsel.
          </div>
        </div>

        <h1 className="text-3xl font-extrabold tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: October 2026</p>

        <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="text-base font-semibold text-foreground">1. Acceptance of Terms</h2>
            <p className="mt-1">
              By accessing or using TaskPilot AI ("the Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, you may not access or use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">2. Description of Service</h2>
            <p className="mt-1">
              TaskPilot AI is an autonomous agent platform that analyzes task dependency graphs, identifies bottlenecks, and drafts reminder actions for human-in-the-loop approval.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">3. User Accounts and Workspaces</h2>
            <p className="mt-1">
              Users may create permanent accounts or utilize guest sessions. You are responsible for safeguarding your credentials and for all activities that take place under your account and workspaces.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">4. Subscriptions and Plans</h2>
            <p className="mt-1">
              TaskPilot AI is currently free to use. Paid subscription tiers are planned for future development. No payments or billing information are collected at this time.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">5. Acceptable Use</h2>
            <p className="mt-1">
              You agree not to misuse the Service, reverse engineer graph reasoning algorithms, introduce malicious cycles, or exceed allocated daily execution quotas.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">6. Limitation of Liability</h2>
            <p className="mt-1">
              The Service is provided "as is" and "as available" without warranties of any kind. Under no circumstances will TaskPilot AI be liable for direct, indirect, incidental, or consequential damages.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
