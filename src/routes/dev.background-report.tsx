import { useCallback, useMemo, useState } from "react";
import { pageHead } from "@/lib/social-meta";
import { devOnlyBeforeLoad } from "@/lib/dev-route-guard";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * On-demand LivingBackground visibility report.
 *
 * Each route is loaded in a hidden same-origin iframe and probed: does the
 * `.living-bg` layer exist, is it actually painting, and does page chrome sit
 * on top of it? Verdicts:
 *
 *  - visible    : background reads through at full strength
 *  - translucent: something semi-opaque (glass panel, tinted shell) sits over it
 *  - blocked    : an opaque surface covers it, or the layer never rendered
 *
 * Internal tooling — noindex, no product content.
 */
export const Route = createFileRoute("/dev/background-report")({
  beforeLoad: devOnlyBeforeLoad,
  head: () =>
    pageHead({
      path: "/dev/background-report",
      title: "Background Visibility Report — Hybrid AI Records Internal",
      description: "Internal audit listing every route and whether the living background renders visible, translucent, or blocked by page styling.",
      socialTitle: "Background Visibility Report — Hybrid AI Records Internal",
      socialDescription: "Per-route check of living background visibility across the site.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: BackgroundReport,
});

type Verdict = "visible" | "translucent" | "blocked" | "error" | "pending";

type Row = {
  path: string;
  verdict: Verdict;
  coverage: number; // 0..1 — how much of the sampled area is obscured
  tier: string;
  detail: string;
};

/** Routes that cannot be probed in an iframe (server endpoints, dynamic params). */
function isProbeable(path: string) {
  if (!path.startsWith("/")) return false;
  if (path.startsWith("/api")) return false;
  if (path.includes("$")) return false;
  if (path.endsWith("/") && path !== "/") return false;
  if (path.includes(".xml")) return false;
  return true;
}

/**
 * Probe script executed against a loaded iframe document. Samples a grid of
 * points, walks each hit element up to <body>, and accumulates the strongest
 * background alpha painted above the living background.
 */
function probe(doc: Document, win: Window) {
  const bg = doc.querySelector<HTMLElement>(".living-bg");
  if (!bg) return { verdict: "blocked" as Verdict, coverage: 1, tier: "-", detail: "no .living-bg element" };

  const bgStyle = win.getComputedStyle(bg);
  const tier = bg.dataset.tier ?? "?";
  if (bgStyle.display === "none" || bgStyle.visibility === "hidden" || Number(bgStyle.opacity) === 0) {
    return { verdict: "blocked" as Verdict, coverage: 1, tier, detail: "layer hidden by CSS" };
  }

  const alphaOf = (color: string) => {
    const m = /rgba?\(([^)]+)\)/.exec(color);
    if (!m) return 0;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  };

  const w = win.innerWidth;
  const h = win.innerHeight;
  const points: Array<[number, number]> = [];
  for (const fx of [0.12, 0.5, 0.88]) {
    for (const fy of [0.15, 0.45, 0.8]) points.push([w * fx, h * fy]);
  }

  let obscured = 0;
  let worst = 0;
  const culprits = new Set<string>();

  for (const [x, y] of points) {
    let el = doc.elementFromPoint(x, y) as HTMLElement | null;
    let alpha = 0;
    let source = "";
    // Stop at <body>: its background-color propagates to the canvas and is
    // painted *behind* the negative-z-index background, so it never blocks it.
    while (el && el !== doc.body && el !== doc.documentElement) {
      if (el.classList.contains("living-bg") || el.closest(".living-bg")) break;
      const s = win.getComputedStyle(el);
      const a = alphaOf(s.backgroundColor);
      if (a > alpha) {
        alpha = a;
        source = el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(/\s+/)[0]}` : "");
      }
      el = el.parentElement;
    }
    if (alpha >= 0.9) obscured += 1;
    if (alpha > worst) worst = alpha;
    if (alpha >= 0.5 && source) culprits.add(source);
  }

  const coverage = obscured / points.length;
  const verdict: Verdict = coverage >= 0.7 ? "blocked" : worst >= 0.15 ? "translucent" : "visible";
  const detail =
    verdict === "visible"
      ? "background reads through"
      : `max overlay alpha ${worst.toFixed(2)}${culprits.size ? ` — ${[...culprits].slice(0, 3).join(", ")}` : ""}`;

  return { verdict, coverage, tier, detail };
}

const VERDICT_STYLE: Record<Verdict, string> = {
  visible: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  translucent: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  blocked: "bg-destructive/20 text-destructive-foreground border-destructive/50",
  error: "bg-muted text-muted-foreground border-border",
  pending: "bg-muted text-muted-foreground border-border",
};

function BackgroundReport() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  const paths = useMemo(() => {
    const ids = Object.keys(router.routesById ?? {});
    const cleaned = ids
      .map((id) => id.replace(/\/_[^/]+/g, "").replace(/\/$/, "") || "/")
      .filter(isProbeable);
    return [...new Set(cleaned)].sort();
  }, [router]);

  const run = useCallback(async () => {
    setRunning(true);
    setRows([]);
    setProgress(0);

    const results: Row[] = [];
    for (const path of paths) {
      const frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText =
        "position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;visibility:hidden;";
      frame.src = path;
      document.body.appendChild(frame);

      const result = await new Promise<Row>((resolve) => {
        const timeout = window.setTimeout(() => {
          resolve({ path, verdict: "error", coverage: 0, tier: "-", detail: "timed out loading" });
        }, 12000);

        frame.onload = () => {
          // Give the background a moment to preload and flip data-ready.
          window.setTimeout(() => {
            window.clearTimeout(timeout);
            try {
              const doc = frame.contentDocument!;
              const win = frame.contentWindow!;
              resolve({ path, ...probe(doc, win) });
            } catch (e) {
              resolve({
                path,
                verdict: "error",
                coverage: 0,
                tier: "-",
                detail: e instanceof Error ? e.message : "probe failed",
              });
            }
          }, 900);
        };
      });

      frame.remove();
      results.push(result);
      setRows([...results]);
      setProgress(results.length / paths.length);
    }

    setRunning(false);
  }, [paths]);

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Background Visibility Report</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Loads every static route in a hidden frame and checks whether the living background is
        visible, dimmed by translucent chrome, or fully covered.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => void run()} disabled={running}>
          {running ? `Scanning… ${Math.round(progress * 100)}%` : "Run report"}
        </Button>
        <span className="text-sm text-muted-foreground">{paths.length} routes</span>
        {rows.length > 0 && (
          <span className="flex gap-2 text-xs">
            <Badge className={VERDICT_STYLE.visible}>{counts.visible ?? 0} visible</Badge>
            <Badge className={VERDICT_STYLE.translucent}>{counts.translucent ?? 0} translucent</Badge>
            <Badge className={VERDICT_STYLE.blocked}>{counts.blocked ?? 0} blocked</Badge>
          </span>
        )}
      </div>

      <div className="mt-8 overflow-hidden rounded-lg border border-border bg-background/40 backdrop-blur-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Route</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Tier</th>
              <th className="px-4 py-3">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                  Run the report to probe each route.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.path} className="border-b border-border/50 last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{r.path}</td>
                <td className="px-4 py-3">
                  <Badge className={VERDICT_STYLE[r.verdict]}>{r.verdict}</Badge>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{r.tier}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
