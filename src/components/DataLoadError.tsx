import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * Inline "we couldn't load this" panel for client-side data fetches.
 *
 * Without it a backend outage renders as an empty list, which reads as
 * "you own nothing" instead of "something broke".
 */
export function DataLoadError({
  message = "We couldn't load this right now.",
  onRetry,
  retrying = false,
  className = "",
}: {
  message?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`rounded-xl border border-border-strong bg-ink/60 p-5 backdrop-blur ${className}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{message}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This is a connection problem, not a change to your account.
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-border-strong px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground transition hover:border-primary hover:text-primary disabled:opacity-60"
            >
              <RotateCcw className={`size-3.5 ${retrying ? "animate-spin" : ""}`} aria-hidden />
              {retrying ? "Retrying…" : "Try again"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
