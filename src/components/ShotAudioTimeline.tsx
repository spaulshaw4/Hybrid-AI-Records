import { memo, useMemo } from "react";
import { AudioWaveform } from "lucide-react";

export type TimelineBlock = {
  index: number;
  title: string;
  seconds: number;
  /** Rendered clip URL when the block is finished. */
  url?: string | null;
};

type Props = {
  blocks: TimelineBlock[];
  /** Browser-derived timing map for the uploaded master. */
  timing?: { durationSeconds: number; energy: number[]; cuts: number[] } | null;
  trackName?: string | null;
};

function timecode(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Shot timeline over the uploaded waveform: each scene block is drawn as a
 * segment across the master's energy envelope so the producer can see exactly
 * where every cut lands against the song.
 */
function ShotAudioTimelineImpl({ blocks, timing, trackName }: Props) {
  const totalSeconds = useMemo(
    () => blocks.reduce((sum, b) => sum + b.seconds, 0) || timing?.durationSeconds || 0,
    [blocks, timing],
  );

  const bars = useMemo(() => {
    const energy = timing?.energy ?? [];
    if (energy.length >= 8) return energy;
    // No analysed envelope yet — draw a flat neutral bed so the cut markers
    // still have a readable track underneath them.
    return Array.from({ length: 64 }, () => 0.35);
  }, [timing]);

  const segments = useMemo(() => {
    let cursor = 0;
    return blocks.map((block) => {
      const start = cursor;
      cursor += block.seconds;
      return {
        ...block,
        start,
        end: cursor,
        leftPct: totalSeconds ? (start / totalSeconds) * 100 : 0,
        widthPct: totalSeconds ? (block.seconds / totalSeconds) * 100 : 0,
      };
    });
  }, [blocks, totalSeconds]);

  if (!blocks.length) return null;

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-muted/30 p-4"
      aria-label="Shot audio timeline"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <AudioWaveform className="size-4 text-primary" aria-hidden />
          Shot timeline
        </p>
        <p className="text-[11px] text-muted-foreground">
          {trackName ? `${trackName} · ` : ""}
          {blocks.length} cuts · {timecode(totalSeconds)}
        </p>
      </div>

      <div className="relative h-20 overflow-hidden rounded-md border border-border bg-background/60">
        <div className="absolute inset-0 flex items-end gap-px px-1 pb-1" aria-hidden>
          {bars.map((value, i) => (
            <span
              key={i}
              className="flex-1 rounded-sm bg-primary/30"
              style={{ height: `${Math.max(6, Math.min(100, value * 100))}%` }}
            />
          ))}
        </div>
        {segments.map((segment) => (
          <div
            key={segment.index}
            className="absolute inset-y-0 border-l border-primary/70"
            style={{ left: `${segment.leftPct}%`, width: `${segment.widthPct}%` }}
            title={`Block ${segment.index + 1} · ${segment.title} · ${timecode(segment.start)}–${timecode(segment.end)}`}
          >
            <span
              className={`absolute left-1 top-1 rounded px-1 text-[10px] font-semibold ${
                segment.url ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              {segment.index + 1}
            </span>
          </div>
        ))}
      </div>

      <ol className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
        {segments.map((segment) => (
          <li key={segment.index} className="flex items-center justify-between gap-2">
            <span className="truncate">
              {segment.index + 1}. {segment.title}
            </span>
            <span className="shrink-0 font-mono">
              {timecode(segment.start)}–{timecode(segment.end)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export const ShotAudioTimeline = memo(ShotAudioTimelineImpl);
