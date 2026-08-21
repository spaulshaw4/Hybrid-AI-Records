import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

const ENTER_MS = 420;

/**
 * "Start Your Project" trigger. Instead of a hard route swap, it raises a
 * full-screen glassmorphism veil over the page and then navigates to /portal.
 * The veil is translucent and blurred, so the LivingBackground loop (mounted in
 * __root, outside the route transition) keeps running and stays visible
 * underneath the whole time.
 */
export function PortalLaunchLink({
  className,
  children,
  onNavigate,
}: {
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const [launching, setLaunching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const start = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Let modified clicks (new tab/window) behave like a normal link.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onNavigate?.();

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      void navigate({ to: "/portal" });
      return;
    }

    setLaunching(true);
    timer.current = setTimeout(() => {
      void navigate({ to: "/portal" });
    }, ENTER_MS);
  };

  return (
    <>
      <a href="/portal" className={className} onClick={start}>
        {children}
      </a>
      {launching && (
        <div className="portal-launch-veil" role="presentation" aria-hidden="true">
          <div className="portal-launch-panel">
            <span className="portal-launch-label">Opening your project portal…</span>
          </div>
        </div>
      )}
    </>
  );
}
