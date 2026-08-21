/**
 * Builds a downloadable JSON analysis report for the Voice Library by pairing
 * each saved clip row with the `.meta.json` sidecar stored next to its audio
 * in the voice-samples bucket.
 */
import { supabase } from "@/integrations/supabase/client";
import { VOICE_SAMPLE_BUCKET } from "@/lib/voice-sample-upload";
import { CLIP_THRESHOLD, SILENCE_FLOOR } from "@/lib/voice-sample-quality";
import type { VoiceProfile } from "@/lib/voice-library.functions";

/** Pulls the storage object path out of a signed voice-samples URL. */
export function samplePathFromUrl(url: string): string | null {
  const match = /\/voice-samples\/([^?]+)/.exec(url);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export type ClipReportEntry = {
  id: string;
  label: string;
  voiceId: string;
  createdAt: string;
  clipPath: string | null;
  metadataPath: string | null;
  /** "ok" when the sidecar was read, otherwise why it was not. */
  metadataStatus: "ok" | "missing" | "unreadable" | "no-path";
  storedAnalysis: {
    peak: number | null;
    rms: number | null;
    clipRatio: number | null;
    silenceRatio: number | null;
    clipBars: number | null;
    silenceBars: number | null;
    totalBars: number | null;
    blocked: boolean | null;
    trimStartSeconds: number | null;
  };
  sidecar: unknown | null;
};

export type ClipAnalysisReport = {
  generatedAt: string;
  bucket: string;
  thresholds: { clipThreshold: number; silenceFloor: number };
  summary: {
    clips: number;
    withSidecar: number;
    withClipping: number;
    withSilence: number;
    flagged: number;
    totalClippingBars: number;
    totalSilenceBars: number;
  };
  clips: ClipReportEntry[];
};

async function readSidecar(path: string): Promise<{ status: ClipReportEntry["metadataStatus"]; data: unknown | null }> {
  const { data, error } = await supabase.storage.from(VOICE_SAMPLE_BUCKET).download(path);
  if (error || !data) return { status: "missing", data: null };
  try {
    return { status: "ok", data: JSON.parse(await data.text()) };
  } catch {
    return { status: "unreadable", data: null };
  }
}

export async function buildClipAnalysisReport(
  voices: VoiceProfile[],
): Promise<ClipAnalysisReport> {
  const clips: ClipReportEntry[] = await Promise.all(
    voices.map(async (voice) => {
      const clipPath = samplePathFromUrl(voice.sample_url);
      const metadataPath = clipPath ? `${clipPath}.meta.json` : null;
      const sidecar = metadataPath ? await readSidecar(metadataPath) : null;
      return {
        id: voice.id,
        label: voice.label,
        voiceId: voice.voice_id,
        createdAt: voice.created_at,
        clipPath,
        metadataPath,
        metadataStatus: sidecar ? sidecar.status : "no-path",
        storedAnalysis: {
          peak: voice.peak,
          rms: voice.rms,
          clipRatio: voice.clip_ratio,
          silenceRatio: voice.silence_ratio,
          clipBars: voice.clip_bars,
          silenceBars: voice.silence_bars,
          totalBars: voice.total_bars,
          blocked: voice.quality_blocked,
          trimStartSeconds: voice.trim_start_seconds,
        },
        sidecar: sidecar?.data ?? null,
      };
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    bucket: VOICE_SAMPLE_BUCKET,
    thresholds: { clipThreshold: CLIP_THRESHOLD, silenceFloor: SILENCE_FLOOR },
    summary: {
      clips: clips.length,
      withSidecar: clips.filter((c) => c.metadataStatus === "ok").length,
      withClipping: clips.filter((c) => (c.storedAnalysis.clipBars ?? 0) > 0).length,
      withSilence: clips.filter((c) => (c.storedAnalysis.silenceBars ?? 0) > 0).length,
      flagged: clips.filter((c) => c.storedAnalysis.blocked === true).length,
      totalClippingBars: clips.reduce((sum, c) => sum + (c.storedAnalysis.clipBars ?? 0), 0),
      totalSilenceBars: clips.reduce((sum, c) => sum + (c.storedAnalysis.silenceBars ?? 0), 0),
    },
    clips,
  };
}

/** Triggers a browser download of the report as a .json file. */
export function downloadReport(report: ClipAnalysisReport, fileName?: string) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName ?? `voice-clip-analysis-${report.generatedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
