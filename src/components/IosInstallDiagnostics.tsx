import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, Share, XCircle } from "lucide-react";
import {
  runIosInstallDiagnostics,
  type Diagnostic,
  type IosInstallReport,
} from "@/lib/ios-install-diagnostics";

/**
 * Self-diagnosing iOS install widget.
 *
 * Runs the environment checks on mount and renders only the steps that apply
 * to the visitor's browser — Safari gets the three-tap Share flow, everyone
 * else gets the "reopen in Safari" path first.
 */

function StatusIcon({ status }: { status: Diagnostic["status"] }) {
  const common = { size: 16, className: "mt-0.5 shrink-0", "aria-hidden": true } as const;
  if (status === "ok") return <CheckCircle2 {...common} className="mt-0.5 shrink-0 text-primary" />;
  if (status === "blocked") return <XCircle {...common} className="mt-0.5 shrink-0 text-destructive" />;
  if (status === "warn")
    return <AlertTriangle {...common} className="mt-0.5 shrink-0 text-muted-foreground" />;
  return <HelpCircle {...common} className="mt-0.5 shrink-0 text-muted-foreground" />;
}

export function IosInstallDiagnostics({ className = "" }: { className?: string }) {
  const [report, setReport] = useState<IosInstallReport | null>(null);

  useEffect(() => {
    let active = true;
    runIosInstallDiagnostics().then((r) => {
      if (active) setReport(r);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!report) {
    return (
      <p
        className={`flex items-center gap-2 text-sm text-muted-foreground ${className}`}
        aria-live="polite"
      >
        <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Checking your browser…
      </p>
    );
  }

  const headline = report.standalone
    ? "You're already running the installed app."
    : report.browser === "safari"
      ? report.canInstall
        ? "You're good to go — three taps and it's on your Home Screen."
        : "Safari is right, but something below is blocking the install."
      : report.browser === "in-app"
        ? "You're in an app's built-in browser — open this page in Safari first."
        : report.browser === "other-browser"
          ? "Apple only lets Safari add apps to the Home Screen."
          : "Home Screen installs work from Safari on iPhone and iPad.";

  return (
    <section className={`space-y-4 text-sm ${className}`} aria-label="iOS install diagnostics">
      <p className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-foreground" aria-live="polite">
        {headline}
      </p>

      <ul className="space-y-2">
        {report.diagnostics.map((d) => (
          <li key={d.id} className="flex gap-2">
            <StatusIcon status={d.status} />
            <span>
              <strong className="text-foreground">{d.label}:</strong>{" "}
              <span className="text-muted-foreground">{d.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      <div>
        <h3 className="font-semibold text-foreground">What to do next</h3>
        {report.browser === "safari" ? (
          <ol className="mt-2 space-y-1.5 text-muted-foreground">
            {report.privateBrowsing === true ? (
              <li>
                <span className="text-primary">1.</span> Leave Private Browsing: tabs button →{" "}
                <strong className="text-foreground">Private</strong> → a normal tab, then reload.
              </li>
            ) : null}
            <li>
              <span className="text-primary">•</span> Tap{" "}
              <Share size={13} className="inline align-[-2px]" aria-hidden="true" />{" "}
              <strong className="text-foreground">Share</strong> in Safari's bottom toolbar.
            </li>
            <li>
              <span className="text-primary">•</span> Swipe up past the app icons and choose{" "}
              <strong className="text-foreground">Add to Home Screen</strong>. Missing? Scroll to{" "}
              <strong className="text-foreground">Edit Actions…</strong> and switch it on.
            </li>
            <li>
              <span className="text-primary">•</span> Tap <strong className="text-foreground">Add</strong> — the
              eagle crest lands on your Home Screen and opens full-screen.
            </li>
          </ol>
        ) : (
          <ul className="mt-2 space-y-1.5 text-muted-foreground">
            <li>
              <strong className="text-foreground">In-app browser</strong> (Instagram, Facebook, TikTok):
              tap <strong className="text-foreground">•••</strong> or{" "}
              <Share size={13} className="inline align-[-2px]" aria-hidden="true" /> →{" "}
              <strong className="text-foreground">Open in Safari</strong>.
            </li>
            <li>
              <strong className="text-foreground">Chrome / Edge / Firefox</strong>: tap ⋯ →{" "}
              <strong className="text-foreground">Open in Safari</strong>, or copy the address and paste
              it into Safari.
            </li>
            <li>Then use Share → Add to Home Screen → Add.</li>
          </ul>
        )}
      </div>
    </section>
  );
}
