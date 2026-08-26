import { useEffect, useRef, useState } from "react";
import { fetchArrayBuffer } from "@/lib/safe-fetch";
import { safeCloseAudioContext } from "@/lib/safe-media";

const BUCKETS = 96;
const peakCache = new Map<string, number[]>();

/** Deterministic stand-in shape used when the audio can't be decoded (CORS, offline). */
function syntheticPeaks(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rand = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1000) / 1000;
  };
  return Array.from({ length: BUCKETS }, (_, i) => {
    const arc = Math.sin((i / BUCKETS) * Math.PI); // quiet intro/outro
    return Math.min(1, 0.22 + arc * (0.45 + rand() * 0.5));
  });
}

async function decodePeaks(src: string): Promise<number[]> {
  const cached = peakCache.get(src);
  if (cached) return cached;
  const buf = await fetchArrayBuffer(src, { mode: "cors" }, "Waveform download");
  const Ctx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const data = audio.getChannelData(0);
    const size = Math.floor(data.length / BUCKETS) || 1;
    const peaks: number[] = [];
    let max = 0;
    for (let i = 0; i < BUCKETS; i++) {
      let peak = 0;
      for (let j = 0; j < size; j++) {
        const v = Math.abs(data[i * size + j] ?? 0);
        if (v > peak) peak = v;
      }
      peaks.push(peak);
      if (peak > max) max = peak;
    }
    const normalized = peaks.map((p) => (max > 0 ? Math.max(0.06, p / max) : 0.06));
    peakCache.set(src, normalized);
    return normalized;
  } finally {
    await safeCloseAudioContext(ctx);
  }
}

export function TrackWaveform({
  src,
  trackId,
  currentTime,
  duration,
  onSeek,
}: {
  src: string;
  trackId: string;
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
}) {
  const [peaks, setPeaks] = useState<number[]>(() => syntheticPeaks(trackId));
  const [approximate, setApproximate] = useState(true);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);


  useEffect(() => {
    let cancelled = false;
    setPeaks(syntheticPeaks(trackId));
    setApproximate(true);
    void (async () => {
      try {
        const real = await decodePeaks(src);
        if (cancelled) return;
        setPeaks(real);
        setApproximate(false);
      } catch {
        // Keep the synthetic shape — scrubbing still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, trackId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
    const played = styles.getPropertyValue("--wave-played").trim() || "#e11d48";
    const rest = styles.getPropertyValue("--wave-rest").trim() || "rgba(255,255,255,0.22)";

    const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
    const gap = 1;
    const barWidth = Math.max(1, width / peaks.length - gap);
    peaks.forEach((p, i) => {
      const x = (width / peaks.length) * i;
      const h = Math.max(2, p * (height - 4));
      ctx.fillStyle = x / width <= progress ? played : rest;
      ctx.fillRect(x, (height - h) / 2, barWidth, h);
    });
  }, [peaks, currentTime, duration]);

  const seekFromEvent = (clientX: number, target: HTMLElement) => {
    if (!duration) return;
    const rect = target.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  };

  const clamp = (t: number) => Math.max(0, Math.min(duration || 0, t));
  const fmt = (t: number) => {
    const s = Math.max(0, Math.round(t));
    return `${Math.floor(s / 60)} minute${Math.floor(s / 60) === 1 ? "" : "s"} ${s % 60} second${s % 60 === 1 ? "" : "s"}`;
  };
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const hintId = `waveform-hint-${trackId}`;

  return (
    <div className="space-y-1">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Audio timeline — scrub playback position"
        aria-orientation="horizontal"
        aria-describedby={hintId}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration) || 0}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`Playhead at ${fmt(currentTime)} of ${fmt(duration)}`}
        aria-disabled={duration ? undefined : true}
        onPointerDown={(e) => {
          if (!duration) return;
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromEvent(e.clientX, e.currentTarget);
        }}
        onPointerMove={(e) => {
          if (!dragging || !duration) return;
          e.preventDefault(); // keep the drawer from scrolling while scrubbing
          seekFromEvent(e.clientX, e.currentTarget);
        }}
        onPointerUp={(e) => {
          if (!dragging) return;
          setDragging(false);
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          seekFromEvent(e.clientX, e.currentTarget);
        }}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(e) => {
          if (!duration) return;
          const step = e.shiftKey ? 1 : 5;
          let next: number | null = null;
          if (e.key === "ArrowRight" || e.key === "ArrowUp") next = currentTime + step;
          else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = currentTime - step;
          else if (e.key === "PageUp") next = currentTime + 30;
          else if (e.key === "PageDown") next = currentTime - 30;
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = duration;
          if (next === null) return;
          e.preventDefault();
          onSeek(clamp(next));
        }}
        className="relative touch-none select-none rounded-md border border-border-strong bg-ink/50 p-1 outline-none transition-colors focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background cursor-pointer"
      >
        <canvas
          aria-hidden="true"
          ref={canvasRef}
          className="pointer-events-none block h-14 w-full [--wave-played:var(--color-primary,#e11d48)] [--wave-rest:rgba(255,255,255,0.2)]"
        />
        <span
          role="presentation"
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-1 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary,#e11d48)] ${dragging ? "w-1" : "w-0.5"}`}
          style={{ left: `calc(0.25rem + ${progress * 100}% )` }}
        />
        {/* Larger invisible touch grip around the playhead for thumb-friendly dragging. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-11 -translate-x-1/2"
          style={{ left: `calc(0.25rem + ${progress * 100}% )` }}
        />
      </div>

      <p id={hintId} className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
        {approximate ? "Waveform preview — approximate shape" : "Waveform — full track structure"} · Arrow keys ±5s,
        Shift ±1s, Page ±30s, Home/End jump
      </p>
      <span className="sr-only" aria-live="polite">
        {`Playhead at ${fmt(currentTime)}`}
      </span>
    </div>
  );
}

