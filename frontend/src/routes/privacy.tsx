import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});

function PrivacyPage() {
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
            This privacy policy document is a template provided for test and preview purposes. It has not been reviewed by legal counsel.
          </div>
        </div>

        <h1 className="text-3xl font-extrabold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: October 2026</p>

        <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="text-base font-semibold text-foreground">1. Information We Collect</h2>
            <p className="mt-1">
              We collect information you provide directly, such as email addresses, project task metadata, deadlines, and workspace configurations. We also collect automated logs and diagnostic traces.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">2. How We Use Information</h2>
            <p className="mt-1">
              Collected information is used exclusively to construct task graphs, perform cycle detection, schedule automated reminders, authenticate requests via Supabase, and prevent quota abuse.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">3. Payment &amp; Financial Information</h2>
            <p className="mt-1">
              TaskPilot AI does not collect or process credit card details or payments. Everything is currently free to use, and any paid tiers remain in future development.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">4. Data Isolation and Multi-Tenancy</h2>
            <p className="mt-1">
              Each workspace uses row-level security (RLS) in PostgreSQL and isolated property graphs in FalkorDB. Your tasks and graph topologies are never exposed to other accounts.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">5. Data Retention &amp; Deletion</h2>
            <p className="mt-1">
              When a workspace is deleted, its associated graph data is permanently destroyed in FalkorDB. Anonymous guest accounts older than 7 days are periodically purged.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
