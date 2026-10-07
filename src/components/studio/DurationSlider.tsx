const TRACK_LENGTH_PRESETS = [30, 60, 120, 180, 240, 300, 360] as const;

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
      <label htmlFor="track-length-seconds" className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
        Track Length (Seconds)
      </label>
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
          className="w-full accent-amber-500"
        />
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Track length">
        {TRACK_LENGTH_PRESETS.map((sec) => (
          <button
            key={sec}
            type="button"
            aria-pressed={value === sec}
            onClick={() => onChange(sec)}
            className={
              value === sec
                ? "rounded-md border border-amber-500/40 bg-amber-500/20 px-2 py-1 text-xs font-semibold text-amber-300"
                : "rounded-md border border-zinc-700 bg-transparent px-2 py-1 text-xs font-semibold text-zinc-400"
            }
          >
            {sec}s
          </button>
        ))}
      </div>
    </div>
  );
}
