import { useEffect, useState } from "react";
import { Check, Copy, LifeBuoy } from "lucide-react";
import type { ErrorRouteContext } from "@/lib/error-context";
import { reportSupportContext } from "@/lib/support-report";

export const SUPPORT_EMAIL = "info@hybrid-ai-records.com";

/** Builds a prefilled support mailto that carries the reference + safe context. */
export function buildSupportMailto(context: ErrorRouteContext, message?: string): string {
  const lines = [
    `Reference: ${context.reference}`,
    `Section: ${context.routeId}`,
    `Page: ${context.pathname}`,
    `Failed during: ${context.stage === "loader" ? "loading data" : "rendering the page"}`,
    context.params.length ? `Page details: ${context.params.join(" · ")}` : null,
    context.search.length ? `Options: ${context.search.join(" · ")}` : null,
    message ? `Message: ${message.slice(0, 300)}` : null,
    typeof window !== "undefined" ? `URL: ${window.location.href}` : null,
    "",
    "What I was doing:",
    "",
  ].filter(Boolean) as string[];

  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    `Site error ${context.reference}`,
  )}&body=${encodeURIComponent(lines.join("\n"))}`;
}

/**
 * Prominent, copyable error reference plus a one-click support email that
 * already contains the same ID, so a report can be triaged immediately.
 */
export function ErrorReference({
  context,
  message,
  className = "",
}: {
  context: ErrorRouteContext;
  message?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  // Record the reference + route context for support triage as soon as the
  // visitor sees it, so a case exists even if they never write in.
  useEffect(() => {
    reportSupportContext(context, { message });
  }, [context, message]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(context.reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className={`rounded-lg border border-primary/40 bg-primary/5 p-3 text-left ${className}`}
    >
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-primary">
        Error reference
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="font-mono text-base font-semibold tracking-wide text-foreground break-all">
          {context.reference}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Copy error reference"
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <a
        href={buildSupportMailto(context, message)}
        onClick={() => reportSupportContext(context, { message, emailStatus: "opened" })}
        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary underline underline-offset-4"
      >
        <LifeBuoy className="size-3.5" aria-hidden="true" />
        Email support with this reference
      </a>
    </div>
  );
}
