const BAR_COUNT = 64;

/** Deterministic pseudo-waveform so a track always renders the same shape. */
function shapeFor(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    const r = ((h >>> 0) % 1000) / 1000;
    // gentle arc envelope keeps it readable instead of noisy
    const env = 0.45 + 0.55 * Math.sin((i / (BAR_COUNT - 1)) * Math.PI);
    out.push(Math.max(0.16, Math.min(1, r * env + 0.18)));
  }
  return out;
}

type Props = {
  seed: string;
  /** 0-100 playback progress */
  pct: number;
  /** 0-100 buffered */
  bufferedPct: number;
  playing: boolean;
};

export function WaveSeek({ seed, pct, bufferedPct, playing }: Props) {
  const bars = shapeFor(seed);
  return (
    <div aria-hidden="true" className="flex h-9 w-full items-center gap-[2px]">
      {bars.map((v, i) => {
        const at = (i / (BAR_COUNT - 1)) * 100;
        const played = at <= pct;
        const buffered = at <= bufferedPct;
        return (
          <span
            key={i}
            className={`min-w-0 flex-1 rounded-[1px] transition-[height,background-color,opacity] duration-200 ${
              played
                ? "bg-primary shadow-[0_0_8px_-2px_rgba(225,29,46,0.9)]"
                : buffered
                  ? "bg-white/25"
                  : "bg-white/10"
            } ${playing && played ? "motion-safe:animate-pulse" : ""}`}
            style={{
              height: `${Math.round(v * 100)}%`,
              animationDelay: playing ? `${(i % 8) * 90}ms` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
