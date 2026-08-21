import { useState } from "react";
import { ShieldCheck, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Security scans are run by the Lovable platform, not by this app.
 * This panel points staff at the Security tab where a re-scan can be
 * triggered and the updated findings are displayed.
 */
export function SecurityScanPanel() {
  const [open, setOpen] = useState(false);

  return (
    <section
      aria-labelledby="security-scan-heading"
      className="mb-8 border border-border-strong bg-card/40 p-5 backdrop-blur-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="security-scan-heading"
            className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground"
          >
            <ShieldCheck size={14} aria-hidden="true" className="text-[#e11d2e]" />
            Security findings
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Database, storage and dependency scans run on the Lovable platform. Start a
            fresh scan there to see updated findings for this project.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="security-scan-steps"
          className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em]"
        >
          <ShieldCheck size={13} aria-hidden="true" /> Re-scan security findings
        </Button>
      </div>

      {open ? (
        <div
          id="security-scan-steps"
          role="status"
          className="mt-4 border-t border-border-strong pt-4 text-sm text-muted-foreground"
        >
          <p className="font-semibold text-foreground">How to re-run the scan</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>
              Open the project in Lovable and select the <strong>Security</strong> shield
              icon in the top navigation (on mobile: <strong>…</strong> → Security).
            </li>
            <li>
              Press <strong>Re-scan</strong> in the Security view to start a fresh scan.
            </li>
            <li>
              Updated findings, severity counts and the “Try to fix all” action appear in
              that same view when the scan completes.
            </li>
          </ol>
          <p className="mt-3 inline-flex items-center gap-1.5 text-xs">
            <ExternalLink size={12} aria-hidden="true" />
            Scans cover RLS policies, storage buckets and dependency vulnerabilities.
          </p>
        </div>
      ) : null}
    </section>
  );
}
