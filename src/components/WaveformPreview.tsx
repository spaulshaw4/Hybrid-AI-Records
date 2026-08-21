import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CLIP_THRESHOLD, SILENCE_FLOOR } from "@/lib/voice-sample-quality";

const BARS = 160;

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Raw (un-normalised) peak per bar, so absolute thresholds can be drawn on top. */
async function computePeaks(file: File): Promise<number[]> {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return [];
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const data = buffer.getChannelData(0);
    const block = Math.max(1, Math.floor(data.length / BARS));
    const peaks: number[] = [];
    for (let i = 0; i < BARS; i += 1) {
      let peak = 0;
      const start = i * block;
      for (let j = start; j < start + block && j < data.length; j += 1) {
        const v = Math.abs(data[j] ?? 0);
        if (v > peak) peak = v;
      }
      peaks.push(peak);
    }
    return peaks;
  } catch {
    return [];
  } finally {
    void ctx.close();
  }
}


type Selection = {
  /** Start of the selected window, in seconds. */
  start: number;
  /** Fixed window length, in seconds. */
  length: number;
  /** Called while the user drags the window across the waveform. */
  onChange: (start: number) => void;
};

type Props = {
  file: File;
  url: string;
  /** Optional caption rendered above the waveform. */
  caption?: string;
  /** When provided, the waveform renders a draggable fixed-length selection window. */
  selection?: Selection;
  /**
   * Draws the absolute clipping ceiling and silence floor used by the quality
   * checker, and tints the bars that trip either one.
   */
  showThresholds?: boolean;
};

/** Canvas waveform with inline playback for a local audio file (pre-upload preview). */
export function WaveformPreview({ file, url, caption, selection, showThresholds }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const dragging = useRef(false);

  const clippedBars = peaks?.filter((p) => p >= CLIP_THRESHOLD).length ?? 0;
  const silentBars = peaks?.filter((p) => p < SILENCE_FLOOR).length ?? 0;

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setCurrent(0);
    setPlaying(false);
    void computePeaks(file).then((result) => {
      if (!cancelled) setPeaks(result);
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(canvas);
    const played = styles.getPropertyValue("--wave-played").trim() || "currentColor";
    const idle = styles.getPropertyValue("--wave-idle").trim() || "currentColor";
    const clipColor = styles.getPropertyValue("--wave-clip").trim() || played;
    const silenceColor = styles.getPropertyValue("--wave-silence").trim() || idle;
    const progress = duration > 0 ? current / duration : 0;
    const gap = 1;
    const barWidth = Math.max(1, width / peaks.length - gap);

    // Absolute full-scale rendering when thresholds are shown, so the drawn
    // ceiling/floor lines line up with real dBFS values; otherwise normalise.
    const loudest = Math.max(...peaks, 0.0001);
    const scale = showThresholds ? 1 : loudest;
    const usable = height - 4;
    const heightFor = (peak: number) => Math.max(2, Math.min(1, peak / scale) * usable);

    const selStart = selection ? selection.start / (duration || 1) : 0;
    const selEnd = selection ? (selection.start + selection.length) / (duration || 1) : 1;

    peaks.forEach((peak, index) => {
      const x = index * (barWidth + gap);
      const h = heightFor(peak);
      const ratio = x / width;
      const inside = !selection || (ratio >= selStart && ratio <= selEnd);
      let color = ratio <= progress ? played : idle;
      if (showThresholds) {
        if (peak >= CLIP_THRESHOLD) color = clipColor;
        else if (peak < SILENCE_FLOOR) color = silenceColor;
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = inside ? 1 : 0.25;
      ctx.fillRect(x, (height - h) / 2, barWidth, h);
    });
    ctx.globalAlpha = 1;

    if (showThresholds) {
      const drawGuide = (level: number, color: string, dash: number[]) => {
        const h = Math.min(1, level) * usable;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(0, (height - h) / 2);
        ctx.lineTo(width, (height - h) / 2);
        ctx.moveTo(0, (height + h) / 2);
        ctx.lineTo(width, (height + h) / 2);
        ctx.stroke();
        ctx.restore();
      };
      // Silence floor is tiny; give it a minimum visual band so it stays visible.
      drawGuide(CLIP_THRESHOLD, clipColor, [4, 3]);
      drawGuide(Math.max(SILENCE_FLOOR, 0.04), silenceColor, [2, 3]);
    }

    if (selection && duration > 0) {
      const x1 = selStart * width;
      const x2 = Math.min(width, selEnd * width);
      ctx.strokeStyle = played;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1 + 1, 1, Math.max(2, x2 - x1 - 2), height - 2);
      ctx.fillStyle = played;
      ctx.fillRect(x1, 0, 3, height);
      ctx.fillRect(Math.max(0, x2 - 3), 0, 3, height);
    }

  }, [peaks, current, duration, selection, showThresholds]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (selection) {
        const outside =
          audio.currentTime < selection.start ||
          audio.currentTime > selection.start + selection.length;
        if (outside) audio.currentTime = selection.start;
      }
      void audio.play();
    } else audio.pause();
  }

  function ratioAt(clientX: number) {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function moveSelection(clientX: number) {
    if (!selection || !duration) return;
    const centre = ratioAt(clientX) * duration;
    const maxStart = Math.max(0, duration - selection.length);
    selection.onChange(Math.min(maxStart, Math.max(0, centre - selection.length / 2)));
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (selection) {
      dragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      moveSelection(event.clientX);
      return;
    }
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = ratioAt(event.clientX) * duration;
    setCurrent(audio.currentTime);
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragging.current) return;
    moveSelection(event.clientX);
  }

  function onPointerUp() {
    dragging.current = false;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!selection || !duration) return;
    const step = event.shiftKey ? 1 : 0.1;
    const maxStart = Math.max(0, duration - selection.length);
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selection.onChange(Math.max(0, selection.start - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      selection.onChange(Math.min(maxStart, selection.start + step));
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
      {caption ? <p className="text-xs text-muted-foreground">{caption}</p> : null}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="icon"
          variant="secondary"
          onClick={toggle}
          aria-label={playing ? "Pause preview" : "Play preview"}
        >
          {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
        </Button>

        <div className="relative min-w-0 flex-1">
          {peaks === null ? (
            <p className="flex h-14 items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Building waveform…
            </p>
          ) : peaks.length === 0 ? (
            <p className="flex h-14 items-center text-xs text-muted-foreground">
              Waveform unavailable for this file — playback still works.
            </p>
          ) : (
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
              tabIndex={selection ? 0 : -1}
              className="h-14 w-full touch-none cursor-pointer text-primary outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring [--wave-clip:hsl(var(--destructive))] [--wave-idle:hsl(var(--muted-foreground)/0.45)] [--wave-played:hsl(var(--primary))] [--wave-silence:hsl(var(--muted-foreground)/0.85)]"
              role={selection ? "slider" : "img"}
              aria-label={
                selection ? "Drag to choose the 10-second window" : "Audio waveform preview"
              }
              {...(selection
                ? {
                    "aria-valuemin": 0,
                    "aria-valuemax": Math.max(0, duration - selection.length),
                    "aria-valuenow": Number(selection.start.toFixed(1)),
                    "aria-valuetext": `Starts at ${formatTime(selection.start)}`,
                  }
                : {})}
            />
          )}
        </div>


        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {formatTime(current)} / {formatTime(duration)}
        </span>
      </div>

      {showThresholds && peaks && peaks.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-0 w-4 border-t border-dashed border-destructive" aria-hidden />
            Clipping ceiling {(20 * Math.log10(CLIP_THRESHOLD)).toFixed(1)} dB
            {clippedBars > 0 ? ` · ${clippedBars} of ${peaks.length} bars hit it` : " · none hit"}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0 w-4 border-t border-dotted border-muted-foreground" aria-hidden />
            Silence floor {(20 * Math.log10(SILENCE_FLOOR)).toFixed(1)} dB
            {silentBars > 0 ? ` · ${silentBars} of ${peaks.length} bars below` : " · none below"}
          </span>
          <span>Bars are drawn at true full scale (0 dB = full height).</span>
        </div>
      ) : null}


      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          if (selection && audio.currentTime >= selection.start + selection.length) {
            audio.pause();
            audio.currentTime = selection.start;
          }
          setCurrent(audio.currentTime);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        className="sr-only"
      />
    </div>
  );
}
