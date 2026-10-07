export function formatTrackTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const remainingSecs = seconds % 60;
  if (mins === 0) return `${remainingSecs} sec`;
  if (remainingSecs === 0) return `${mins} min`;
  return `${mins} min ${remainingSecs} sec`;
}

const quickPresets = [30, 60, 90, 120, 150, 180, 210, 240, 300, 360];

function clampTrackLength(value: number): number {
  return Math.min(360, Math.max(30, Number(value) || 30));
}

export function DurationSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (seconds: number) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="track-length-seconds" className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Track Length
        </label>
        <span className="text-xs font-semibold tabular-nums text-zinc-200">{formatTrackTime(value)}</span>
      </div>
      <p className="text-xs text-zinc-500">Length follows the lyric arrangement.</p>
      <div className="flex items-center gap-3">
        <input
          id="track-length-seconds"
          aria-label="Track Length (Seconds)"
          type="number"
          min={30}
          max={360}
          step={5}
          value={value}
          onChange={(event) => onChange(clampTrackLength(Number(event.target.value)))}
          className="w-20 rounded-md border border-zinc-700 bg-transparent px-2 py-1 text-sm text-zinc-100"
        />
        <input
          aria-label="Track length slider"
          type="range"
          min={30}
          max={360}
          step={15}
          value={value}
          onChange={(event) => onChange(clampTrackLength(Number(event.target.value)))}
          className="w-full accent-red-600"
        />
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Track length">
        {quickPresets.map((sec) => (
          <button
            key={sec}
            type="button"
            aria-pressed={value === sec}
            onClick={() => onChange(sec)}
            className={
              value === sec
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
