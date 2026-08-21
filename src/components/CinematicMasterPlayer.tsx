import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Download, Film, Loader2, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { MasterVideoPlayer } from "@/components/MasterVideoPlayer";


export type MasterClip = {
  index: number;
  title: string;
  seconds: number;
  url: string;
};

const STAGE_LABEL: Record<string, string> = {
  load: "Warming the assembly node",
  fetch: "Collecting rendered blocks",
  concat: "Building the timeline",
  scale: "Local 4K scaling pass (lanczos • unsharp)",
  mux: "Binding master audio",
};


function clock(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Plays the stitched master: every scene block is rendered separately, then
 * played back-to-back as one continuous timeline with the next clip preloaded
 * so the hand-off between blocks is seamless.
 */
function CinematicMasterPlayerBase({
  clips,
  audioUrl,
  audioFile,
  masterSeconds,
}: {
  clips: MasterClip[];
  /** The uploaded song, muxed onto the welded master so it is never silent. */
  audioUrl?: string | null;
  /** The original uploaded master audio file, held through the whole render. */
  audioFile?: File | Blob | null;
  /** Exact audio runtime — the export is hard-clamped to it (no silent tail). */
  masterSeconds?: number | null;
}) {

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [clipTime, setClipTime] = useState(0);
  const [stitching, setStitching] = useState(false);
  const [stitchPercent, setStitchPercent] = useState(0);
  const [stitchStage, setStitchStage] = useState<string | null>(null);
  const [masterFile, setMasterFile] = useState<{ url: string; extension: string } | null>(null);
  // Resolution scaling is a local FFmpeg pass only — default is native 1080p.
  const [scale, setScale] = useState<"native" | "4k">("native");

  // Release the object URL when a new master replaces it or the view unmounts.
  useEffect(() => {
    return () => {
      if (masterFile) URL.revokeObjectURL(masterFile.url);
    };
  }, [masterFile]);

  const buildMaster = useCallback(async () => {
    // Mandatory audio: no export leaves this studio silent. Without the master
    // track held there is nothing to mux, so assembly refuses to run.
    const masterAudio = audioFile ?? audioUrl;
    if (!masterAudio) {
      toast.error("Drop the master audio file first — exports are never rendered without sound.");
      return;
    }
    setStitching(true);
    setStitchPercent(0);
    try {
      // Assembly stage: concatenate the silent blocks and mux the original
      // master audio on top with FFmpeg — the video stream is never re-encoded.
      const { remuxMaster, canRemuxMaster } = await import("@/lib/ffmpeg-master");

      if (canRemuxMaster()) {
        try {
          const result = await remuxMaster(
            clips.map((clip) => clip.url),
            masterAudio,
            (progress) => {
              setStitchPercent(progress.percent);
              setStitchStage(STAGE_LABEL[progress.stage] ?? null);
            },
            scale,
            masterSeconds ?? undefined,
          );

          setMasterFile({ url: URL.createObjectURL(result.blob), extension: result.extension });
          toast.success("Master assembled — audio muxed onto the untouched video stream.");
          return;
        } catch {
          toast.message("Falling back to the in-browser welder for this master…");
        }
      }

      // The welder can only bind an audio URL. Without one there is no way to
      // guarantee sound on the export, so it is blocked rather than shipped mute.
      if (!audioUrl) {
        toast.error("Master audio couldn't be muxed on this device — the silent export is blocked.");
        return;
      }
      const { stitchMaster, canStitchMaster } = await import("@/lib/stitch-master");
      if (!canStitchMaster()) {
        toast.error("This browser can't weld the master file. Open the studio on desktop.");
        return;
      }
      const result = await stitchMaster(
        clips.map((clip) => clip.url),
        (progress) => setStitchPercent(progress.percent),
        audioUrl ?? null,
      );
      setMasterFile({ url: URL.createObjectURL(result.blob), extension: result.extension });
      toast.success("Full master welded into a single file.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't build the master file.");
    } finally {
      setStitching(false);
      setStitchStage(null);
    }
  }, [clips, audioUrl, audioFile, scale, masterSeconds]);

  // Assemble automatically once every block is rendered and a master track is
  // held, so the player shows the remuxed film with sound from 0:00.
  const autoBuilt = useRef(false);
  useEffect(() => {
    if (autoBuilt.current) return;
    if (!clips.length || (!audioFile && !audioUrl)) return;
    autoBuilt.current = true;
    void buildMaster();
  }, [clips.length, audioFile, audioUrl, buildMaster]);


  const total = clips.reduce((sum, clip) => sum + clip.seconds, 0);
  const elapsedBefore = clips.slice(0, current).reduce((sum, clip) => sum + clip.seconds, 0);
  const active = clips[current];

  const goTo = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(clips.length - 1, index));
      setCurrent(next);
      setClipTime(0);
    },
    [clips.length],
  );

  // Autoplay the next block when the current one ends.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (playing) void el.play().catch(() => setPlaying(false));
  }, [current, playing]);

  if (!active) return null;

  return (
    <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">
          Cinematic master — {clips.length} scene{clips.length === 1 ? "" : "s"} • {clock(total)}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {/* Final scaling happens locally in this browser — zero cloud cost. */}
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <input
              type="checkbox"
              checked={scale === "4k"}
              disabled={stitching}
              onChange={(e) => setScale(e.target.checked ? "4k" : "native")}
              className="size-3.5 accent-primary"
            />
            Local 4K scaling pass (this device)
          </label>


          {/* Blocks render silent by design — only the muxed master is exportable. */}
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Download className="size-3.5" aria-hidden /> Export unlocks on the muxed master
          </span>
        </div>
      </div>

      {masterFile && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">
            Final remuxed master — song plays from 0:00
          </p>
          <MasterVideoPlayer src={masterFile.url} extension={masterFile.extension} />
        </div>
      )}

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        // Stable identity: React swaps only the `src`, so switching blocks
        // never tears down and rebuilds the viewport element.
        key="cinematic-viewport"
        ref={videoRef}
        src={active.url}
        className="w-full rounded-md bg-black"
        controls
        playsInline
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        // Whole-second granularity: timeupdate fires ~4-60x/s and each raw
        // update re-rendered the player during playback.
        onTimeUpdate={(e) => {
          const next = Math.floor(e.currentTarget.currentTime);
          setClipTime((prev) => (Math.floor(prev) === next ? prev : next));
        }}
        onEnded={() => {
          if (current < clips.length - 1) {
            setPlaying(true);
            goTo(current + 1);
          } else {
            setPlaying(false);
          }
        }}
      />

      {/* Preload the next block so playback rolls straight through. */}
      {clips[current + 1] && (
        <video src={clips[current + 1]!.url} preload="auto" className="hidden" muted />
      )}

      <div className="space-y-1.5">
        <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
          {clips.map((clip, i) => (
            <button
              key={clip.index}
              type="button"
              onClick={() => goTo(i)}
              style={{ flexGrow: clip.seconds }}
              aria-label={`Play ${clip.title}`}
              className={`h-full rounded-full transition-colors ${
                i < current ? "bg-primary" : i === current ? "bg-primary/70" : "bg-muted-foreground/30"
              }`}
            />
          ))}
        </div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="truncate">
            Scene {current + 1}/{clips.length} — {active.title}
          </span>
          <span>
            {clock(elapsedBefore + clipTime)} / {clock(total)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => goTo(current - 1)}
          disabled={current === 0}
        >
          <SkipBack className="size-4" aria-hidden />
        </Button>
        <Button
          type="button"
          size="sm"
          className="flex-1"
          onClick={() => {
            const el = videoRef.current;
            if (!el) return;
            if (el.paused) void el.play().catch(() => undefined);
            else el.pause();
          }}
        >
          {playing ? (
            <>
              <Pause className="size-4" aria-hidden /> Pause master
            </>
          ) : (
            <>
              <Play className="size-4" aria-hidden /> Play full master
            </>
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => goTo(current + 1)}
          disabled={current >= clips.length - 1}
        >
          <SkipForward className="size-4" aria-hidden />
        </Button>
      </div>

      <ol className="max-h-40 space-y-1 overflow-y-auto text-[11px]">
        {clips.map((clip, i) => (
          <li key={clip.index}>
            <button
              type="button"
              onClick={() => goTo(i)}
              className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left ${
                i === current ? "bg-primary/10 text-foreground" : "text-muted-foreground"
              }`}
            >
              <span className="w-5 shrink-0 tabular-nums">{i + 1}.</span>
              <span className="truncate">{clip.title}</span>
              <span className="ml-auto shrink-0">{clock(clip.seconds)}</span>
            </button>
          </li>
        ))}
      </ol>

      {/* One continuous file: every finished block welded end-to-end. */}
      <div className="space-y-2 rounded-lg border border-border bg-background/60 p-3">
        <p className="text-[11px] text-muted-foreground">
          Weld all {clips.length} block{clips.length === 1 ? "" : "s"} ({clock(total)}) into one
          continuous master file you can download and publish.
          {audioUrl
            ? " Your uploaded track is mixed onto the master from 0:00."
            : " Drop your song in the script step to mix it onto the master."}
        </p>
        {stitching && <Progress value={stitchPercent} className="h-1.5" />}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={buildMaster}
            disabled={stitching || (!audioFile && !audioUrl)}
          >
            {stitching ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Welding master…{" "}
                {stitchStage ? `${stitchStage} — ` : ""}
                {stitchPercent}%
              </>
            ) : (
              <>
                <Film className="size-4" aria-hidden /> Build full master file
              </>
            )}
          </Button>
          {masterFile && (
            <a
              href={masterFile.url}
              download={`hybrid-cinematic-master.${masterFile.extension}`}
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary underline"
            >
              <Download className="size-3.5" aria-hidden /> Download full master
            </a>
          )}
        </div>
        {/* The remuxed master has a single viewport above — a second <video>
            on the same object URL doubled decode work and flashed on updates. */}
      </div>

    </div>
  );
}

/**
 * Memoised so the studio's 1s render clock and streaming progress updates never
 * re-render (and never remount) the video viewport mid-playback.
 */
export const CinematicMasterPlayer = memo(CinematicMasterPlayerBase);
