import { AlertTriangle, Archive, Loader2, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Link, type ErrorComponentProps } from "@tanstack/react-router";
import { useErrorRouteContext } from "@/lib/error-context";
import { useRouteRetry } from "@/lib/use-route-retry";
import { ErrorReference } from "@/components/ErrorReference";
import { captureAppException } from "@/lib/sentry-capture";


/**
 * Shown instead of a blank screen when a route component throws — a missing
 * import, a bad render, or a loader failure. Keeps the page branded and gives
 * the visitor a way back in without a hard refresh loop.
 */
export function RouteErrorFallback({ error, reset }: ErrorComponentProps) {
  const context = useErrorRouteContext(error);
  const { retry, isRetrying, attempts, cached } = useRouteRetry(context.routeId, reset);
  const message =
    error instanceof Error && error.message ? error.message : "Something went wrong.";

  useEffect(() => {
    captureAppException(error, {
      tags: { source: "route_error_fallback" },
      extra: { routeId: context.routeId, stage: context.stage },
    });
  }, [error, context.routeId, context.stage]);


  return (
    <main
      role="alert"
      className="flex min-h-dvh items-center justify-center px-6 py-24"
    >
      <div className="w-full max-w-lg rounded-2xl border border-border/60 border-l-2 border-l-primary bg-card/70 p-8 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <AlertTriangle className="size-6 text-primary" aria-hidden="true" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            We hit a snag loading this section
          </h1>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          The rest of the site is fine — try again, and if it keeps happening reload
          the page or head back to the front page.
        </p>
        <dl className="mt-4 grid gap-1 rounded-lg border border-border/50 bg-background/50 p-3 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <dt className="min-w-24 text-foreground/80">Section</dt>
            <dd className="font-mono break-all">{context.routeId}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="min-w-24 text-foreground/80">Failed during</dt>
            <dd>{context.stage === "loader" ? "loading data" : "rendering the page"}</dd>
          </div>
          {context.params.length > 0 && (
            <div className="flex gap-2">
              <dt className="min-w-24 text-foreground/80">Page details</dt>
              <dd className="font-mono break-all">{context.params.join(" · ")}</dd>
            </div>
          )}
          {context.search.length > 0 && (
            <div className="flex gap-2">
              <dt className="min-w-24 text-foreground/80">Options</dt>
              <dd className="font-mono break-all">{context.search.join(" · ")}</dd>
            </div>
          )}
        </dl>
        <ErrorReference context={context} message={message} className="mt-4" />

        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border/50 bg-background/60 p-3">
            {message}
          </pre>
        </details>
        {cached && (
          <section className="mt-4 rounded-lg border border-border/50 bg-background/50 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-foreground">
              <Archive className="size-4 text-primary" aria-hidden="true" />
              Showing the last version we loaded
              <span className="font-normal text-muted-foreground">
                · {new Date(cached.capturedAt).toLocaleTimeString()}
              </span>
            </div>
            <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
              {cached.fields.map((field) => (
                <div key={field.label} className="flex gap-2">
                  <dt className="min-w-24 text-foreground/80">{field.label}</dt>
                  <dd className="font-mono break-all">{field.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        {attempts >= 1 && !cached && (
          <p className="mt-4 text-xs text-muted-foreground">
            The retry didn’t clear it and there’s no saved copy of this section yet —
            reload the page or head back to the front page.
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => void retry()} disabled={isRetrying} className="gap-2">
            {isRetrying ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="size-4" aria-hidden="true" />
            )}
            {isRetrying ? "Retrying…" : attempts >= 1 ? "Try again anyway" : "Try again"}
          </Button>

          <Button variant="outline" asChild>
            <Link to="/">Go home</Link>
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
          >
            Reload page
          </Button>
        </div>
      </div>
    </main>
  );
}
