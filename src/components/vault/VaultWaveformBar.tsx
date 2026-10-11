/** Relative EQ heights, centered like the radio player's WaveSeek bars. */
const BAR_HEIGHTS = [
  0.22, 0.34, 0.48, 0.28, 0.62, 0.78, 0.4, 0.7, 0.55, 0.88, 0.36, 0.66, 0.5, 0.3, 0.74, 0.92,
  0.44, 0.6, 0.32, 0.8, 0.58, 0.26, 0.7, 0.84, 0.42, 0.64, 0.38, 0.9, 0.52, 0.28, 0.76, 0.46,
  0.68, 0.34, 0.82, 0.5, 0.24, 0.6, 0.72, 0.4, 0.56, 0.3, 0.78, 0.48, 0.66, 0.36, 0.44, 0.22,
];

type VaultWaveformBarProps = {
  currentTime?: string;
  duration?: string;
  /** Pulse the bar track only while this row is the one playing. */
  isPlaying?: boolean;
  /** 0–100. Bars at or before this position use the played red style. */
  progressPercent?: number;
  /**
   * Optional seek, as a 0–100 percent. Without it the bar is display-only
   * so it does not compete with an existing player control.
   */
  onSeek?: (percent: number) => void;
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function VaultWaveformBar({
  currentTime = "0:00",
  duration = "0:00",
  isPlaying = false,
  progressPercent = 0,
  onSeek,
}: VaultWaveformBarProps) {
  const pct = clampPercent(progressPercent);
  const bars = (
    <div
      aria-hidden="true"
      className={`flex h-9 w-full items-center gap-[2px] ${
        isPlaying ? "animate-glow-red motion-reduce:animate-none" : "opacity-70"
      }`}
    >
      {BAR_HEIGHTS.map((height, index) => {
        const at = ((index + 1) / BAR_HEIGHTS.length) * 100;
        const played = at <= pct;
        return (
          <span
            key={index}
            className={`min-w-0 flex-1 rounded-[1px] ${
              played
                ? "bg-red-500 shadow-[0_0_8px_-2px_rgba(225,29,46,0.9)]"
                : "bg-white/10"
            }`}
            style={{ height: `${Math.round(height * 100)}%` }}
          />
        );
      })}
    </div>
  );

  return (
    <div className="mt-2 flex items-center gap-3">
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {currentTime}
      </span>
      {onSeek ? (
        <div className="relative min-w-0 flex-1 py-1">
          {bars}
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={pct}
            aria-label="Seek within the current track"
            aria-valuetext={`${currentTime} of ${duration}`}
            onChange={(event) => onSeek(clampPercent(Number(event.target.value)))}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </div>
      ) : (
        <div
          className="min-w-0 flex-1"
          role="progressbar"
          aria-label="Playback progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-valuetext={`${currentTime} of ${duration}`}
        >
          {bars}
        </div>
      )}
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {duration}
      </span>
    </div>
  );
}
