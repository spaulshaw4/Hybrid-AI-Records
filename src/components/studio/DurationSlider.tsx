export function formatTrackTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const remainingSecs = seconds % 60;
  if (mins === 0) return `${remainingSecs} sec`;
  if (remainingSecs === 0) return `${mins} min`;
  return `${mins} min ${remainingSecs} sec`;
}

const TRACK_LENGTH_PRESETS = [30, 60, 90, 120, 150, 180, 210, 240, 300, 360];

function clampTrackLength(value: number, maxSeconds: number): number {
  return Math.min(maxSeconds, Math.max(30, Number(value) || 30));
}

export function DurationSlider({
  value,
  onChange,
  maxSeconds = 360,
}: {
  value: number;
  onChange: (seconds: number) => void;
  maxSeconds?: number;
}) {
  const limit = Math.min(360, Math.max(30, maxSeconds));
  const shown = clampTrackLength(value, limit);
  const presets = TRACK_LENGTH_PRESETS.filter((seconds) => seconds <= limit);
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="track-length-seconds" className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Track Length
        </label>
        <span className="text-xs font-semibold tabular-nums text-zinc-200">{formatTrackTime(shown)}</span>
      </div>
      <p className="text-xs text-zinc-500">Length follows the lyric arrangement.</p>
      <div className="flex items-center gap-3">
        <input
          id="track-length-seconds"
          aria-label="Track Length (Seconds)"
          type="number"
          min={30}
          max={limit}
          step={5}
          value={shown}
          onChange={(event) => onChange(clampTrackLength(Number(event.target.value), limit))}
          className="w-20 rounded-md border border-zinc-700 bg-transparent px-2 py-1 text-sm text-zinc-100"
        />
        <input
          aria-label="Track length slider"
          type="range"
          min={30}
          max={limit}
          step={15}
          value={shown}
          onChange={(event) => onChange(clampTrackLength(Number(event.target.value), limit))}
          className="w-full accent-red-600"
        />
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Track length">
        {presets.map((sec) => (
          <button
            key={sec}
            type="button"
            aria-pressed={shown === sec}
            onClick={() => onChange(sec)}
            className={
              shown === sec
                ? "rounded-md border border-red-500/40 bg-red-500/20 px-2 py-1 text-xs font-semibold text-red-400"
                : "rounded-md border border-zinc-700 bg-transparent px-2 py-1 text-xs font-semibold text-zinc-400"
            }
          >
            {formatTrackTime(sec)}
          </button>
        ))}
      </div>
    </div>
  );
}
