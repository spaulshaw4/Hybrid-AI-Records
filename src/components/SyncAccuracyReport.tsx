import { memo, useMemo } from "react";
import { Download, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AudioTimingMap } from "@/lib/audio-timing";
import { buildSyncReport, SYNC_GRADE_LABEL, type SyncBlock } from "@/lib/sync-diagnostics";

type Props = {
  blocks: SyncBlock[];
  timing: AudioTimingMap | null;
  lipSyncedIndexes?: number[];
  trackName?: string | null;
};

const GRADE_CLASS: Record<string, string> = {
  locked: "text-primary",
  tight: "text-primary",
  drifting: "text-amber-500",
  "out-of-sync": "text-destructive",
};

/** Post-render review card: how closely the picture tracks the song. */
function SyncAccuracyReportImpl({ blocks, timing, lipSyncedIndexes, trackName }: Props) {
  const report = useMemo(
    () => buildSyncReport({ blocks, timing, lipSyncedIndexes: lipSyncedIndexes ?? [] }),
    [blocks, timing, lipSyncedIndexes],
  );

  const download = () => {
    const blob = new Blob([JSON.stringify({ track: trackName ?? null, ...report }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "sync-accuracy-report.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!blocks.length) return null;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Gauge className="size-4 text-primary" aria-hidden />
          Sync accuracy
        </p>
        <span className={`text-xs font-semibold ${GRADE_CLASS[report.grade] ?? ""}`}>
          {SYNC_GRADE_LABEL[report.grade]}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Picture</dt>
          <dd className="font-semibold text-foreground">{report.pictureSeconds.toFixed(1)}s</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Song</dt>
          <dd className="font-semibold text-foreground">
            {report.audioSeconds ? `${report.audioSeconds.toFixed(1)}s` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Avg drift</dt>
          <dd className="font-semibold text-foreground">
            {report.averageDriftSeconds.toFixed(2)}s
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Worst drift</dt>
          <dd className="font-semibold text-foreground">{report.worstDriftSeconds.toFixed(2)}s</dd>
        </div>
      </dl>

      <ul className="space-y-1 text-xs text-muted-foreground">
        {report.notes.map((note) => (
          <li key={note}>• {note}</li>
        ))}
      </ul>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Per-block boundaries</summary>
        <ol className="mt-2 space-y-1">
          {report.boundaries.map((boundary) => (
            <li key={boundary.blockIndex} className="flex justify-between gap-2">
              <span className="truncate text-foreground">{boundary.title}</span>
              <span className="shrink-0 text-muted-foreground">
                {boundary.cutAtSeconds.toFixed(2)}s
                {boundary.nearestBeatSeconds !== null &&
                  ` · ${boundary.driftSeconds >= 0 ? "+" : ""}${boundary.driftSeconds.toFixed(2)}s`}
              </span>
            </li>
          ))}
        </ol>
      </details>

      <Button type="button" size="sm" variant="outline" onClick={download}>
        <Download className="size-4" aria-hidden />
        Download report
      </Button>
    </div>
  );
}

export const SyncAccuracyReport = memo(SyncAccuracyReportImpl);
export default SyncAccuracyReport;
