/**
 * Read-only metadata panel for the clip currently open in the Voice Library:
 * the exact trim window plus the silence / clipping analysis that will be
 * stored alongside the upload.
 */
import { useState } from "react";
import { ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  CLIP_THRESHOLD,
  SILENCE_FLOOR,
  toDb,
  type SampleQuality,
} from "@/lib/voice-sample-quality";

type Props = {
  fileName: string;
  fileSizeBytes: number;
  trimStart: number;
  trimLength: number;
  sourceDuration: number;
  quality: SampleQuality | null;
};

function clock(seconds: number) {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/40 py-1 last:border-b-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  );
}

export function ClipMetadataPanel({
  fileName,
  fileSizeBytes,
  trimStart,
  trimLength,
  sourceDuration,
  quality,
}: Props) {
  const [open, setOpen] = useState(false);
  const trimEnd = trimStart + trimLength;

  const metadata = {
    originalName: fileName,
    sizeBytes: fileSizeBytes,
    trimStartSeconds: Number(trimStart.toFixed(3)),
    trimEndSeconds: Number(trimEnd.toFixed(3)),
    trimDurationSeconds: Number(trimLength.toFixed(3)),
    sourceDurationSeconds: Number(sourceDuration.toFixed(3)),
    quality: quality
      ? {
          peak: Number(quality.peak.toFixed(4)),
          rms: Number(quality.rms.toFixed(4)),
          clipRatio: Number(quality.clipRatio.toFixed(4)),
          silenceRatio: Number(quality.silenceRatio.toFixed(4)),
          clipBars: quality.clipBars,
          silenceBars: quality.silenceBars,
          totalBars: quality.totalBars,
          blocked: quality.blocked,
          issues: quality.issues.map((issue) => `${issue.level}: ${issue.message}`),
        }
      : null,
    thresholds: { clipThreshold: CLIP_THRESHOLD, silenceFloor: SILENCE_FLOOR },
  };

  return (
    <div className="rounded-xl border border-border/60 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium"
      >
        Clip metadata — trim window &amp; analysis
        <ChevronDown
          className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border/40 p-3">
          <dl>
            <Row label="File" value={fileName} />
            <Row label="Size" value={`${Math.max(1, Math.round(fileSizeBytes / 1024))} KB`} />
            <Row label="Trim start" value={`${clock(trimStart)} (${trimStart.toFixed(2)}s)`} />
            <Row label="Trim end" value={`${clock(trimEnd)} (${trimEnd.toFixed(2)}s)`} />
            <Row label="Trim length" value={`${trimLength.toFixed(2)}s`} />
            <Row label="Source length" value={`${clock(sourceDuration)}`} />
          </dl>

          <dl>
            <Row label="Peak level" value={quality ? toDb(quality.peak) : "—"} />
            <Row label="Average level" value={quality ? toDb(quality.rms) : "—"} />
            <Row
              label={`Clipped frames (≥ ${toDb(CLIP_THRESHOLD)})`}
              value={quality ? `${(quality.clipRatio * 100).toFixed(2)}%` : "—"}
            />
            <Row
              label={`Silent frames (≤ ${toDb(SILENCE_FLOOR)})`}
              value={quality ? `${(quality.silenceRatio * 100).toFixed(2)}%` : "—"}
            />
            <Row
              label="Clipping bars"
              value={quality ? `${quality.clipBars} of ${quality.totalBars}` : "—"}
            />
            <Row
              label="Silent bars"
              value={quality ? `${quality.silenceBars} of ${quality.totalBars}` : "—"}
            />
            <Row
              label="Verdict"
              value={
                !quality
                  ? "analysing"
                  : quality.blocked
                    ? "blocked"
                    : quality.issues.length > 0
                      ? "warning"
                      : "pass"
              }
            />
          </dl>

          {quality && quality.issues.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {quality.issues.map((issue) => (
                <li key={issue.id}>
                  {issue.level === "block" ? "Blocked" : "Warning"}: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(JSON.stringify(metadata, null, 2));
                  toast.success("Clip metadata copied.");
                } catch {
                  toast.error("Could not copy the metadata.");
                }
              }}
            >
              <Copy className="mr-2 size-4" aria-hidden />
              Copy metadata JSON
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
