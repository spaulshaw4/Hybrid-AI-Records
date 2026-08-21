import { useRenderLoopGuard } from "@/hooks/useRenderLoopGuard";
import { memo, useEffect, useState } from "react";
import { Check, Clapperboard, Loader2, PlayCircle, Radio, RefreshCw, TriangleAlert } from "lucide-react";

export type RenderPhaseId = "script" | "soundtrack" | "render" | "archive";

export type RenderPhaseState = "pending" | "active" | "done" | "failed";

export type SceneProgress = {
  index: number;
  title: string;
  seconds: number;
  state: RenderPhaseState;
  /** 0-100 for the block currently rendering. */
  percent?: number | undefined;
};

export type CinematicProgress = {
  phase: RenderPhaseId;
  phaseState: RenderPhaseState;
  percent: number;
  engine: "primary" | "backup" | "reserve" | null;
  scenes: SceneProgress[];
  startedAt: number;
  etaSeconds: number | null;
  note?: string | undefined;
};

const PHASES: { id: RenderPhaseId; label: string; detail: string }[] = [
  { id: "script", label: "Script breakdown", detail: "Splitting the script into scene blocks" },
  { id: "soundtrack", label: "Soundtrack brief", detail: "Scoring direction for the master" },
  { id: "render", label: "Scene render", detail: "Rendering shots on the V Engine" },
  { id: "archive", label: "Master archive", detail: "Encoding and securing playback" },
];

const ENGINE_LABEL: Record<"primary" | "backup" | "reserve", string> = {
  primary: "V Engine Prime",
  backup: "V Engine Backup",
  reserve: "V Engine Reserve",
};

function clock(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function CinematicRenderProgressBase({
  progress,
  onRetry,
  onResume,
  retrying = false,
}: {
  progress: CinematicProgress;
  /** One-click retry of the failed scene blocks; omitted when nothing failed. */
  onRetry?: (() => void) | undefined;
  /** Resume an interrupted sequence from the last completed checkpoint. */
  onResume?: (() => void) | undefined;
  retrying?: boolean;
}) {
  // The elapsed clock lives here, not in the studio route. Ticking it in the
  // parent re-rendered the entire studio (script box, mood board, player)
  // once a second, which is what made the viewport flash and reset.
  const [now, setNow] = useState(() => Date.now());
  const [clockHalted, setClockHalted] = useState(false);
  // Loop safeguard: if this panel ever repaints faster than a progress feed
  // ever should, stop the clock and log one diagnostic.
  useRenderLoopGuard("cinematic-render-progress", {
    limit: 30,
    onTrip: () => setClockHalted(true),
    context: () => ({ phase: progress.phase, percent: progress.percent }),
  });
  useEffect(() => {
    if (clockHalted) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [clockHalted]);


  const activeIndex = PHASES.findIndex((p) => p.id === progress.phase);
  const elapsed = Math.max(0, (now - progress.startedAt) / 1000);

  const percent = Math.min(100, Math.max(0, Math.round(progress.percent)));
  const totalScenes = progress.scenes.length;
  const readyScenes = progress.scenes.filter((s) => s.state === "done").length;
  const failedScenes = progress.scenes.filter((s) => s.state === "failed").length;

  // Checkpoint = the last block that finished; resume picks up right after it.
  const checkpoint = progress.scenes.reduce(
    (last, scene, i) => (scene.state === "done" ? i + 1 : last),
    0,
  );
  const unfinished = totalScenes - readyScenes;
  const canResume = Boolean(onResume) && unfinished > 0 && progress.phaseState !== "active";

  const secondsReady = progress.scenes
    .filter((s) => s.state === "done")
    .reduce((sum, s) => sum + s.seconds, 0);

  return (
    <section
      aria-live="polite"
      className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
          <Clapperboard className="size-4" aria-hidden /> Render in progress
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {totalScenes > 0 && (
            <span
              aria-live="polite"
              className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-background/60 px-2.5 py-1 text-[11px] font-semibold text-foreground"
            >
              {readyScenes} of {totalScenes} blocks ready
              {secondsReady > 0 && (
                <span className="text-muted-foreground">• {clock(secondsReady)} rendered</span>
              )}
            </span>
          )}
          {progress.engine && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-background/60 px-2.5 py-1 text-[11px] font-semibold text-foreground">
              <Radio className="size-3.5 text-primary" aria-hidden />
              {ENGINE_LABEL[progress.engine]}
              {progress.engine !== "primary" && (
                <span className="text-muted-foreground">(failover)</span>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Cinematic render progress"
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{percent}% complete</span>
          <span>
            Elapsed {clock(elapsed)}
            {progress.etaSeconds !== null && ` • ~${clock(progress.etaSeconds)} left`}
          </span>
        </div>
      </div>

      <ol className="space-y-2">
        {PHASES.map((phase, i) => {
          const state: RenderPhaseState =
            i < activeIndex
              ? "done"
              : i === activeIndex
                ? progress.phaseState
                : "pending";
          return (
            <li key={phase.id} className="flex items-start gap-2.5">
              <PhaseIcon state={state} />
              <div className="min-w-0">
                <p
                  className={`text-xs font-semibold ${
                    state === "pending" ? "text-muted-foreground" : "text-foreground"
                  }`}
                >
                  {phase.label}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {state === "failed" ? (progress.note ?? "This step failed.") : phase.detail}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {progress.phaseState === "failed" && onRetry && (

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
          <p className="text-[11px] text-foreground">
            {failedScenes > 0
              ? `${failedScenes} block${failedScenes === 1 ? "" : "s"} failed. Retry picks up from the first unfinished block — finished blocks and your V Tokens are kept.`
              : "This render stopped early. Retry resumes from the first unfinished block."}
          </p>
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/50 bg-primary/15 px-3 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/25 disabled:opacity-60"
          >
            {retrying ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
            {retrying ? "Retrying blocks…" : "Retry failed blocks"}
          </button>
        </div>
      )}

      {canResume && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-background/60 p-3">
          <p className="text-[11px] text-muted-foreground">
            Checkpoint saved at block {checkpoint} of {totalScenes}.{" "}
            <span className="text-foreground">
              {unfinished} block{unfinished === 1 ? "" : "s"} left
            </span>{" "}
            — resuming never re-renders finished blocks or re-charges V Tokens.
          </p>
          <button
            type="button"
            onClick={onResume}
            disabled={retrying}
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/50 bg-primary/10 px-3 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
          >
            {retrying ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <PlayCircle className="size-3.5" aria-hidden />
            )}
            {retrying ? "Resuming…" : `Resume from block ${checkpoint + 1}`}
          </button>
        </div>
      )}

      {progress.scenes.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-border bg-background/50 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Scenes ({readyScenes}/{totalScenes} ready)
          </p>

          <ol className="space-y-1">
            {progress.scenes.map((scene) => (
              <li key={scene.index} className="flex items-center gap-2 text-[11px]">
                <PhaseIcon state={scene.state} />
                <span
                  className={`truncate ${
                    scene.state === "pending" ? "text-muted-foreground" : "text-foreground"
                  }`}
                >
                  {scene.title}
                </span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {scene.state === "active" && typeof scene.percent === "number"
                    ? `${Math.min(99, Math.max(0, Math.round(scene.percent)))}%`
                    : scene.state === "done"
                      ? "ready"
                      : clock(scene.seconds)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/**
 * Memoised: the studio ticks a 1s clock while rendering, so this panel would
 * otherwise re-render the whole phase list on every unrelated parent update.
 * Only a real progress/clock change repaints it — the viewport never flashes.
 */
export const CinematicRenderProgress = memo(CinematicRenderProgressBase);

function PhaseIcon({ state }: { state: RenderPhaseState }) {
  if (state === "done")
    return <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />;
  if (state === "active")
    return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden />;
  if (state === "failed")
    return <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />;
  return (
    <span
      className="mt-1.5 size-2 shrink-0 rounded-full border border-muted-foreground/50"
      aria-hidden
    />
  );
}
