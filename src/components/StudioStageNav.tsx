import { useCallback, useEffect, useState } from "react";

type Stage = { id: string; label: string };

const STAGES: Stage[] = [
  { id: "stage-audio", label: "1 · Drop my track" },
  { id: "stage-character", label: "2 · Character" },
  { id: "stage-script", label: "3 · Scene" },
  { id: "stage-beat", label: "4 · Beat blocks" },
  { id: "stage-render", label: "5 · Render" },
];

/**
 * Sticky in-page navigation for the Visual Engine stages. Keeps the long
 * production flow navigable without breaking the single-page layout.
 */
export function StudioStageNav() {
  const [active, setActive] = useState<string>(STAGES[0]!.id);

  useEffect(() => {
    const nodes = STAGES.map((s) => document.getElementById(s.id)).filter(
      (n): n is HTMLElement => Boolean(n),
    );
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target.id) setActive(visible.target.id);
      },
      { rootMargin: "-96px 0px -60% 0px", threshold: 0.01 },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  });

  const go = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <nav
      aria-label="Studio stages"
      className="sticky top-0 z-30 -mx-4 border-b border-border/60 bg-background/85 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60"
    >
      <ul className="flex gap-2 overflow-x-auto">
        {STAGES.map((s) => {
          const isActive = active === s.id;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => go(s.id)}
                aria-current={isActive ? "step" : undefined}
                className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {s.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
