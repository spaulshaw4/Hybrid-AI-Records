import { useCallback, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  readRetryAttempts,
  readRouteSnapshot,
  writeRetryAttempts,
  type RouteSnapshot,
} from "@/lib/route-snapshot";

/**
 * "Try again" behaviour shared by the route and root error boundaries:
 * re-runs the failed route's loader and waits for the result. If the retry
 * fails again, exposes the last cached snapshot of that route so the visitor
 * still sees real content instead of a dead end.
 */
export function useRouteRetry(routeId: string, reset: () => void) {
  const router = useRouter();
  const [isRetrying, setIsRetrying] = useState(false);
  const [attempts, setAttempts] = useState(() => readRetryAttempts(routeId));

  const retry = useCallback(async () => {
    setIsRetrying(true);
    const next = attempts + 1;
    writeRetryAttempts(routeId, next);
    setAttempts(next);
    try {
      // sync: true waits for the loaders to finish, so a still-broken route
      // surfaces here instead of flashing the page and erroring again.
      await router.invalidate({ sync: true });
    } catch {
      // Swallowed: the boundary below reports the outcome.
    } finally {
      setIsRetrying(false);
      reset();
    }
  }, [attempts, reset, router, routeId]);

  // Only offer cached content once a retry has actually been attempted.
  const cached = useMemo<RouteSnapshot | null>(
    () => (attempts >= 1 ? readRouteSnapshot(routeId) : null),
    [attempts, routeId],
  );

  return { retry, isRetrying, attempts, cached };
}
