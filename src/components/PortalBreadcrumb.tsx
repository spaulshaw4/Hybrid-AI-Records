import * as React from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Home } from "lucide-react";

import { useSwipeBack } from "@/hooks/useSwipeBack";

export type PortalCrumb = {
  /** Visible label for this step. */
  label: string;
  /** Optional route — omit for the current page. */
  to?: string;
  /** Optional search params for the linked route. */
  search?: Record<string, unknown>;
};

/**
 * Consistent portal navigation: a home affordance that is always present,
 * followed by the trail for the current view. Tap targets stay at 44px on
 * mobile and the trail scrolls horizontally instead of wrapping.
 *
 * On touch devices an edge swipe from the left goes back (browser history when
 * available, otherwise the fallback route) with a live drag indicator.
 */
export function PortalBreadcrumb({
  trail = [],
  backTo = "/",
  backLabel = "Home",
}: {
  trail?: PortalCrumb[];
  /** Where back navigation lands when there is no in-app history. */
  backTo?: string;
  /** Label shown on the mobile back control. */
  backLabel?: string;
}) {
  const router = useRouter();

  // Warm the back destination so the transition feels instant.
  React.useEffect(() => {
    void router.preloadRoute({ to: backTo }).catch(() => {});
  }, [router, backTo]);

  const goBack = React.useCallback(() => {
    const canGoBack = router.history.canGoBack?.() ?? false;
    if (canGoBack) router.history.back();
    else void router.navigate({ to: backTo });
  }, [router, backTo]);

  const progress = useSwipeBack(goBack);
  const armed = progress >= 1;

  return (
    <>
      {/* Live swipe affordance — only visible while dragging from the edge. */}
      {progress > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-y-0 start-0 z-[120] flex items-center"
          style={{ transform: `translateX(${progress * 12}px)` }}
        >
          <div
            className={`grid h-12 w-12 place-items-center rounded-e-full border border-s-0 backdrop-blur-md transition-colors ${
              armed
                ? "border-primary bg-primary/20 text-primary"
                : "border-border bg-ink/70 text-muted-foreground"
            }`}
            style={{ opacity: 0.35 + progress * 0.65 }}
          >
            <ChevronLeft size={20} />
          </div>
        </div>
      )}

      <nav
        aria-label="Breadcrumb"
        className="-mx-1 mb-6 flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        {/* Mobile-first explicit back control; the trail carries desktop nav. */}
        <button
          type="button"
          onClick={goBack}
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border px-3 font-mono text-[11px] uppercase tracking-[0.18em] text-white transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
        >
          <ChevronLeft size={14} aria-hidden="true" />
          <span>Back to {backLabel.toLowerCase()}</span>
        </button>

        <ol className="flex min-w-max items-center gap-1 overflow-x-auto font-mono text-[11px] uppercase tracking-[0.18em] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <li>
            <Link
              to="/"
              preload="intent"
              className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Home size={14} aria-hidden="true" className="shrink-0" />
              <span>Home</span>
            </Link>
          </li>
          {trail.map((crumb, index) => {
            const isLast = index === trail.length - 1;
            return (
              <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-border" />
                {crumb.to && !isLast ? (
                  <Link
                    to={crumb.to}
                    search={crumb.search as never}
                    preload="intent"
                    className="inline-flex min-h-11 items-center rounded-md px-2 text-muted-foreground transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    aria-current={isLast ? "page" : undefined}
                    className="inline-flex min-h-11 items-center px-2 text-white"
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
