/**
 * Compares the metadata saved for a cloned voice (the row written when the
 * clip was uploaded) against the `.meta.json` analysis sidecar stored next to
 * the audio in the voice-samples bucket, so drift between the two is visible.
 */
import { supabase } from "@/integrations/supabase/client";
import { VOICE_SAMPLE_BUCKET } from "@/lib/voice-sample-upload";
import { samplePathFromUrl } from "@/lib/voice-analysis-report";
import type { VoiceProfile } from "@/lib/voice-library.functions";

export type DiffStatus = "same" | "changed" | "only-record" | "only-sidecar" | "absent";

export type MetadataDiffRow = {
  key: string;
  label: string;
  /** Value stored on the saved voice record. */
  record: string;
  /** Value found in the uploaded clip's .meta.json sidecar. */
  sidecar: string;
  status: DiffStatus;
};

export type SidecarLoad =
  | { status: "ok"; data: Record<string, unknown> }
  | { status: "missing" | "unreadable" | "no-path" };

/** Downloads and parses the `.meta.json` sidecar for a saved clip. */
export async function loadClipSidecar(sampleUrl: string): Promise<SidecarLoad> {
  const clipPath = samplePathFromUrl(sampleUrl);
  if (!clipPath) return { status: "no-path" };
  const { data, error } = await supabase.storage
    .from(VOICE_SAMPLE_BUCKET)
    .download(`${clipPath}.meta.json`);
  if (error || !data) return { status: "missing" };
  try {
    const parsed: unknown = JSON.parse(await data.text());
    if (!parsed || typeof parsed !== "object") return { status: "unreadable" };
    return { status: "ok", data: parsed as Record<string, unknown> };
  } catch {
    return { status: "unreadable" };
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads a nested sidecar value, tolerating both flat and `quality.*` shapes. */
function pick(sidecar: Record<string, unknown> | null, ...paths: string[]): unknown {
  if (!sidecar) return undefined;
  for (const path of paths) {
    let current: unknown = sidecar;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

type Formatter = (value: unknown) => string | null;

const seconds: Formatter = (v) => {
  const n = num(v);
  return n === null ? null : `${n.toFixed(3)}s`;
};
const ratio: Formatter = (v) => {
  const n = num(v);
  return n === null ? null : `${(n * 100).toFixed(2)}%`;
};
const level: Formatter = (v) => {
  const n = num(v);
  return n === null ? null : n.toFixed(4);
};
const count: Formatter = (v) => {
  const n = num(v);
  return n === null ? null : String(Math.round(n));
};
const bool: Formatter = (v) => (typeof v === "boolean" ? (v ? "yes" : "no") : null);
const text: Formatter = (v) => (typeof v === "string" && v.trim() ? v : null);

type FieldSpec = {
  key: string;
  label: string;
  format: Formatter;
  record: (voice: VoiceProfile) => unknown;
  sidecar: string[];
};

const FIELDS: FieldSpec[] = [
  {
    key: "originalName",
    label: "Original file",
    format: text,
    record: () => undefined,
    sidecar: ["originalName"],
  },
  {
    key: "trimStart",
    label: "Trim start",
    format: seconds,
    record: (v) => v.trim_start_seconds,
    sidecar: ["trimStartSeconds"],
  },
  {
    key: "trimEnd",
    label: "Trim end",
    format: seconds,
    record: () => undefined,
    sidecar: ["trimEndSeconds"],
  },
  {
    key: "trimDuration",
    label: "Trim length",
    format: seconds,
    record: () => undefined,
    sidecar: ["trimDurationSeconds"],
  },
  {
    key: "sourceDuration",
    label: "Source length",
    format: seconds,
    record: () => undefined,
    sidecar: ["sourceDurationSeconds"],
  },
  { key: "peak", label: "Peak level", format: level, record: (v) => v.peak, sidecar: ["peak", "quality.peak"] },
  { key: "rms", label: "Average level", format: level, record: (v) => v.rms, sidecar: ["rms", "quality.rms"] },
  {
    key: "clipRatio",
    label: "Clipped frames",
    format: ratio,
    record: (v) => v.clip_ratio,
    sidecar: ["clipRatio", "quality.clipRatio"],
  },
  {
    key: "silenceRatio",
    label: "Silent frames",
    format: ratio,
    record: (v) => v.silence_ratio,
    sidecar: ["silenceRatio", "quality.silenceRatio"],
  },
  {
    key: "clipBars",
    label: "Clipping bars",
    format: count,
    record: (v) => v.clip_bars,
    sidecar: ["clipBars", "quality.clipBars"],
  },
  {
    key: "silenceBars",
    label: "Silent bars",
    format: count,
    record: (v) => v.silence_bars,
    sidecar: ["silenceBars", "quality.silenceBars"],
  },
  {
    key: "totalBars",
    label: "Total bars",
    format: count,
    record: (v) => v.total_bars,
    sidecar: ["totalBars", "quality.totalBars"],
  },
  {
    key: "blocked",
    label: "Flagged / blocked",
    format: bool,
    record: (v) => v.quality_blocked,
    sidecar: ["qualityBlocked", "quality.blocked"],
  },
];

/** Builds the side-by-side rows for one saved clip. */
export function buildClipMetadataDiff(
  voice: VoiceProfile,
  sidecar: Record<string, unknown> | null,
): MetadataDiffRow[] {
  return FIELDS.map((field) => {
    const recordValue = field.format(field.record(voice));
    const sidecarValue = field.format(pick(sidecar, ...field.sidecar));

    let status: DiffStatus;
    if (recordValue === null && sidecarValue === null) status = "absent";
    else if (recordValue === null) status = "only-sidecar";
    else if (sidecarValue === null) status = "only-record";
    else status = recordValue === sidecarValue ? "same" : "changed";

    return {
      key: field.key,
      label: field.label,
      record: recordValue ?? "—",
      sidecar: sidecarValue ?? "—",
      status,
    };
  });
}

/** Rows that actually differ (used for the summary count). */
export function countDifferences(rows: MetadataDiffRow[]) {
  return rows.filter((row) => row.status === "changed").length;
}
