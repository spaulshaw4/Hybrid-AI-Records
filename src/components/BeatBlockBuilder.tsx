import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Square, Timer, Zap, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  renderCinematicScene,
  pollCinematicRender,
  cancelCinematicRender,
} from "@/lib/cinematic-render.functions";
import { PRODUCER_NAME } from "@/lib/producer-identity";
import promptDatabase from "../../public/prompt-master-database.json";

/** The beat-block cadence is locked: every block covers exactly 5 seconds. */
export const BEAT_BLOCK_SECONDS = 5;
/**
 * The diffusion engine only accepts 4s / 6s / 8s takes, so a 5s beat block is
 * dispatched as the nearest take that fully covers the block (6s) and trimmed
 * back to 5s at mux time.
 */
const ENGINE_SECONDS = 6;

const CAMERA_MOVES = [
  "slow dolly-in",
  "handheld push",
  "orbiting arc shot",
  "crane rise",
  "static locked-off frame",
  "whip-pan transition",
  "low-angle tracking shot",
  "rapid dynamic push-in",
] as const;

const ENERGIES = [
  "smouldering and restrained",
  "steady and hypnotic",
  "driving and aggressive",
  "explosive, strobing peak",
] as const;

/** Sample a random prompt row from the master database for inspiration. */
function randomPromptRow() {
  const rows = promptDatabase as Array<{
    camera_move?: string;
    subject?: string;
    environment?: string;
    lighting?: string;
    render?: string;
    prompt?: string;
  }>;
  return rows[Math.floor(Math.random() * rows.length)] ?? {};
}

type BlockState = "idle" | "dispatching" | "rendering" | "done" | "failed";

type Props = {
  /** Style/grade language already selected upstage. */
  styleMode: string;
  subjectMode: string;
  /** Governing Genre Visual Law, or null for auto. */
  genreId: string | null;
  /** Character anchor frame so faces stay consistent across blocks. */
  referenceImage?: string | undefined;
  /** Detected tempo, used to describe the beat grid to the engine. */
  bpm?: number | null;
  /** Returns the master-track slice under this block as a wav data URL. */
  sliceAudio?: (startSeconds: number, seconds: number) => Promise<string | null>;
  disabled?: boolean;
};

/**
 * Five-Second Beat-Synced Pipeline: clean consumer-facing shell with a
 * hidden producer mode. The block dispatches a parameterised prompt straight to
 * the render engine — no script pass, no queue — and polls the job from the
 * browser.
 */
export function BeatBlockBuilder({
  styleMode,
  subjectMode,
  genreId,
  referenceImage,
  bpm,
  sliceAudio,
  disabled,
}: Props) {
  const dispatchScene = useServerFn(renderCinematicScene);
  const pollScene = useServerFn(pollCinematicRender);
  const cancelScene = useServerFn(cancelCinematicRender);

  const [subject, setSubject] = useState("");
  const [environment, setEnvironment] = useState("");
  const [camera, setCamera] = useState<string>(CAMERA_MOVES[0]);
  const [energy, setEnergy] = useState<string>(ENERGIES[1]);
  const [startAt, setStartAt] = useState(0);

  const [state, setState] = useState<BlockState>("idle");
  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState<string>("");
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showProducerTools, setShowProducerTools] = useState(false);

  const jobRef = useRef<string | null>(null);
  const abortRef = useRef(false);

  useEffect(() => () => { abortRef.current = true; }, []);

  /** The exact parameterised payload sent to the inference worker. */
  const buildShotPrompt = useCallback(() => {
    const beatNote = bpm
      ? `Cut on the ${bpm} BPM beat grid, one accent every ${(60 / bpm).toFixed(2)}s.`
      : "Cut on the musical beat grid of the supplied audio.";
    return [
      `[SCENE SPEC: ${BEAT_BLOCK_SECONDS}s BEAT-LOCKED]`,
      `Concept: ${camera} on ${subject.trim() || (subjectMode === "scenery" ? "the environment" : "the performer")}`,
      `in ${environment.trim() || "a moody, atmospheric location"}.`,
      `Style: ${styleMode} look, ${energy} energy, 4K anamorphic, photorealistic, strict character/style continuity, zero wandering elements.`,
      `Camera: ${camera}, steady cinematic framing, precise composition, no random transformations.`,
      beatNote,
      `Exactly ${BEAT_BLOCK_SECONDS} seconds of continuous motion — no static slides, no freeze frames, no text overlays.`,
      `Produced by ${PRODUCER_NAME} for Hybrid AI Records LLC.`,
    ].join("\n");
  }, [camera, subject, subjectMode, environment, styleMode, energy, bpm]);

  const autoFill = useCallback(() => {
    const row = randomPromptRow();
    setCamera((row.camera_move ?? CAMERA_MOVES[0]).toLowerCase());
    setSubject(row.subject ?? "the performer");
    setEnvironment(row.environment ?? "a moody atmospheric location");
    toast.success("Producer prompt auto-filled from master database");
  }, []);

  const buildBlock = useCallback(async () => {
    if (state === "dispatching" || state === "rendering") return;
    abortRef.current = false;
    setError(null);
    setClipUrl(null);
    setPercent(0);
    setStage("Assembling 5s beat block from master database...");
    setState("dispatching");

    const shot = buildShotPrompt();
    let audioReference: string | null = null;
    try {
      audioReference = sliceAudio ? await sliceAudio(startAt, BEAT_BLOCK_SECONDS) : null;
    } catch {
      audioReference = null;
    }

    console.log("[cinematic] beat block dispatch", {
      shot,
      seconds: ENGINE_SECONDS,
      blockSeconds: BEAT_BLOCK_SECONDS,
      startAt,
      genreId,
      audio: Boolean(audioReference),
    });

    try {
      setStage("Dispatching to inference pipeline...");
      const dispatched = await dispatchScene({
        data: {
          shot,
          seconds: ENGINE_SECONDS,
          ...(referenceImage ? { referenceImage } : {}),
          ...(genreId ? { genreId } : {}),
          ...(audioReference ? { audioReference } : {}),
        },
      });
      if (!dispatched.ok) {
        const detail = "detail" in dispatched ? (dispatched.detail ?? "") : "";
        const message = detail ? `${dispatched.error} — ${detail}` : dispatched.error;
        setError(message);
        setState("failed");
        toast.error(message);
        return;
      }
      jobRef.current = dispatched.jobId;
      setState("rendering");

      // Browser-side polling: no server wait loop, no held connection.
      while (!abortRef.current) {
        await new Promise((r) => setTimeout(r, 4000));
        if (abortRef.current) break;
        const poll = await pollScene({ data: { jobId: dispatched.jobId } });
        setPercent(Math.max(0, Math.min(100, poll.progress ?? 0)));
        setStage(poll.stage ?? poll.status);
        if (poll.status === "completed" && poll.videoUrl) {
          setClipUrl(poll.videoUrl);
          setPercent(100);
          setState("done");
          jobRef.current = null;
          return;
        }
        if (poll.status === "failed") {
          const message = poll.error ?? "The block render failed.";
          setError(message);
          setState("failed");
          jobRef.current = null;
          toast.error(message);
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "The block render failed.";
      console.error("[cinematic] beat block failed", err);
      setError(message);
      setState("failed");
      toast.error(message);
    }
  }, [
    state,
    buildShotPrompt,
    sliceAudio,
    startAt,
    dispatchScene,
    pollScene,
    referenceImage,
    genreId,
  ]);

  const cancel = useCallback(async () => {
    abortRef.current = true;
    const jobId = jobRef.current;
    jobRef.current = null;
    setState("idle");
    setStage("");
    setPercent(0);
    if (jobId) {
      try {
        await cancelScene({ data: { jobId } });
      } catch (err) {
        console.error("[cinematic] beat block cancel failed", err);
      }
    }
  }, [cancelScene]);

  const busy = state === "dispatching" || state === "rendering";
  const activePrompt = state === "idle" && !error ? "" : buildShotPrompt();

  return (
    <Card id="stage-beat" className="scroll-mt-24">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Timer className="size-5 text-primary" aria-hidden />
              Stage 4 — 5-Second Beat-Synced Pipeline
            </CardTitle>
            <CardDescription>
              Duration is locked to {BEAT_BLOCK_SECONDS} seconds per block. Building a block dispatches
              the parameterised prompt payload straight to the render engine.
            </CardDescription>
          </div>
          <button
            onClick={() => setShowProducerTools(!showProducerTools)}
            className="text-xs font-mono px-3 py-1.5 rounded border border-white/60 bg-white/80 text-slate-600 hover:text-foreground transition-colors"
          >
            {showProducerTools ? "Hide Producer Specs" : "Producer Mode"}
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Consumer-facing clean interface */}
        <div className="p-6 border border-white/60 rounded-xl studio-glass flex flex-col items-center justify-center text-center">
          <div className="w-full max-w-xl aspect-video bg-slate-900/80 border border-white/40 rounded-lg flex items-center justify-center relative overflow-hidden group">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(126,18,32,0.2)_0%,transparent_70%)]" />
            {clipUrl ? (
              <video
                src={clipUrl}
                controls
                playsInline
                className="relative z-10 w-full h-full object-contain"
              />
            ) : (
              <p className="text-xs font-mono text-muted-foreground z-10">
                {busy ? `Rendering ${BEAT_BLOCK_SECONDS}s shot…` : "Select a scene track and hit render below"}
              </p>
            )}
          </div>

          <div className="mt-6 flex gap-4 items-center w-full max-w-xl justify-between">
            <span className="text-xs font-mono text-muted-foreground">
              Target Pace: <span className="text-red-400 font-bold">{BEAT_BLOCK_SECONDS}s Beat Locked</span>
            </span>
            <Button
              onClick={() => void buildBlock()}
              disabled={busy || disabled}
              className="px-6 py-2.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-all shadow-lg shadow-red-950/50"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Zap className="size-4" aria-hidden />
              )}
              {busy ? `Rendering ${BEAT_BLOCK_SECONDS}s Shot…` : "Generate Beat Shot"}
            </Button>
          </div>

          {busy && (
            <div className="mt-4 w-full max-w-xl space-y-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-red-600 transition-all"
                  style={{ width: `${Math.max(4, percent)}%` }}
                />
              </div>
              <p className="text-xs font-mono text-muted-foreground">
                {stage} · {Math.round(percent)}%
              </p>
            </div>
          )}
        </div>

        {/* Producer controls — hidden by default */}
        {showProducerTools && (
          <div className="mt-8 p-4 border border-primary/20 rounded-xl bg-primary/5 space-y-4">
            <h3 className="text-xs font-mono uppercase tracking-wider text-red-400">
              Producer Debug & Engine Diagnostics
            </h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="beat-subject">Subject</Label>
                <Input
                  id="beat-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="the artist in a leather trench coat"
                  disabled={busy || disabled}
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="beat-environment">Environment</Label>
                <Input
                  id="beat-environment"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                  placeholder="a rain-slicked neon alley at 3am"
                  disabled={busy || disabled}
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="beat-camera">Camera move</Label>
                <Select value={camera} onValueChange={setCamera} disabled={busy || disabled}>
                  <SelectTrigger id="beat-camera">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CAMERA_MOVES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="beat-energy">Energy</Label>
                <Select value={energy} onValueChange={setEnergy} disabled={busy || disabled}>
                  <SelectTrigger id="beat-energy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENERGIES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="beat-start">Track start (seconds)</Label>
                <Input
                  id="beat-start"
                  type="number"
                  min={0}
                  step={BEAT_BLOCK_SECONDS}
                  value={startAt}
                  onChange={(e) => setStartAt(Math.max(0, Number(e.target.value) || 0))}
                  disabled={busy || disabled}
                />
              </div>
              <div className="space-y-2">
                <Label>Block length</Label>
                <div className="flex h-9 items-center rounded-md border border-border bg-muted px-3 text-sm text-muted-foreground">
                  Locked at {BEAT_BLOCK_SECONDS}s
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void autoFill()}
                disabled={busy || disabled}
              >
                <Wand2 className="size-4 mr-2" aria-hidden />
                Auto-fill from Prompt DB
              </Button>
              {busy && (
                <Button variant="outline" size="sm" onClick={() => void cancel()}>
                  <Square className="size-4" aria-hidden />
                  Cancel
                </Button>
              )}
            </div>

            {stage && (
              <div className="p-3 border border-white/60 rounded studio-glass font-mono text-xs text-primary">
                {stage}
              </div>
            )}

            <div className="p-4 border border-white/60 rounded studio-glass">
              <p className="text-xs font-mono text-muted-foreground">Compiled Prompt Payload:</p>
              <p className="mt-2 text-sm text-foreground whitespace-pre-line font-mono">
                {activePrompt || "No payload compiled yet."}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
            <Button size="sm" variant="outline" onClick={() => void buildBlock()}>
              Try again
            </Button>
          </div>
        )}

        {clipUrl && !busy && (
          <div className="text-center">
            <a
              href={clipUrl}
              download
              className="text-sm font-medium text-primary underline underline-offset-4"
            >
              Download block
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
