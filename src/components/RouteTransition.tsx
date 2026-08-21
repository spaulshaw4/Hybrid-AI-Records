import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Cross-fades route content on navigation. The LivingBackground lives outside
 * this wrapper in __root, so its animation state is never remounted or reset —
 * only the page content fades between routes.
 */
export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div key={pathname} className="route-transition">
      {children}
    </div>
  );
}
