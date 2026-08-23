/**
 * Gate 2 — CWALO all-in-one music structure analysis (Replicate).
 *
 * Runs after Gate 1 base audio is ready and before Gate 3 Demucs.
 * Extracts section boundaries, tempo, and remux gain hints so the
 * instrumental bed is never attenuated through transitions / outro.
 */

import Replicate from "replicate";

import { replicateApiKey } from "@/lib/ai-provider.server";
import { StudioPipelineError } from "@/lib/studio-pipeline-error";
import { logGateCleared, isHttpAudioUrl } from "@/lib/pipeline-contracts";

/** Pinned model + version hash (do not float to latest). */
export const CWALO_MODEL =
  "cwalo/all-in-one-music-structure-analysis:6deeba047db17da69e9826c0285cd137cd2a81af05eb44ff496b7acd69b3a383";

export type CwaloSection = {
  start: number;
  end: number;
  label: string;
};

export type CwaloRemuxGains = {
  /** Gate 3 instrumental bed level for FFmpeg volume= */
  instrumentalVolume: number;
  /** Fish vocal stem level for FFmpeg volume= */
  vocalVolume: number;
};

export type CwaloStructure = {
  bpm: number | null;
  beats: number[];
  downbeats: number[];
  sections: CwaloSection[];
  durationSeconds: number | null;
  remux: CwaloRemuxGains;
  raw: unknown;
};

const DEFAULT_REMUX: CwaloRemuxGains = {
  instrumentalVolume: 1.0,
  vocalVolume: 1.0,
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(asNumber).filter((n): n is number => n != null);
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[_-]+/g, " ");
}

/** Sections where the instrumental bed must stay full-level. */
const BED_PROTECT_LABELS = [
  "outro",
  "outro fade",
  "transition",
  "break",
  "bridge",
  "inst",
  "instrumental",
  "drop",
  "build",
  "buildup",
  "silence",
];

/** Sections that typically carry lead vocal energy. */
const VOCAL_POCKET_LABELS = ["verse", "chorus", "hook", "refrain", "pre chorus", "prechorus"];

function parseSection(row: unknown): CwaloSection | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const start = asNumber(r.start ?? r.begin ?? r.from);
  const end = asNumber(r.end ?? r.to ?? r.stop);
  const label = String(r.label ?? r.name ?? r.section ?? "").trim();
  if (start == null || end == null || !label) return null;
  return { start, end, label };
}

/**
 * Pull structure fields from an all-in-one JSON document (or nested wrapper).
 */
export function parseCwaloAnalysisJson(doc: unknown): Omit<CwaloStructure, "raw" | "remux"> {
  const root =
    doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {};
  const nested =
    root.result && typeof root.result === "object"
      ? (root.result as Record<string, unknown>)
      : root.analysis && typeof root.analysis === "object"
        ? (root.analysis as Record<string, unknown>)
        : root;

  const bpm = asNumber(nested.bpm ?? nested.tempo ?? root.bpm);
  const beats = asNumberArray(nested.beats ?? root.beats);
  const downbeats = asNumberArray(nested.downbeats ?? root.downbeats);
  const segmentSource = nested.segments ?? nested.sections ?? root.segments ?? root.sections;
  const sections = (Array.isArray(segmentSource) ? segmentSource : [])
    .map(parseSection)
    .filter((s): s is CwaloSection => Boolean(s));

  let durationSeconds =
    asNumber(nested.duration ?? nested.duration_seconds ?? root.duration) ?? null;
  if (durationSeconds == null && sections.length > 0) {
    durationSeconds = Math.max(...sections.map((s) => s.end));
  }

  return { bpm, beats, downbeats, sections, durationSeconds };
}

/** Remux gains: keep bed solid through outro/transition; slight vocal lift in pockets. */
export function remuxGainsFromStructure(
  sections: CwaloSection[],
): CwaloRemuxGains {
  if (sections.length === 0) return { ...DEFAULT_REMUX };

  const labels = sections.map((s) => normalizeLabel(s.label));
  const protectsBed = labels.some((l) =>
    BED_PROTECT_LABELS.some((needle) => l.includes(needle)),
  );
  const hasVocalPockets = labels.some((l) =>
    VOCAL_POCKET_LABELS.some((needle) => l.includes(needle)),
  );

  return {
    // Keep both stems at unity — amix normalize=0 holds the bed constant;
    // never drop the bed when CWALO sees outro/transition material.
    instrumentalVolume: protectsBed ? 1.0 : DEFAULT_REMUX.instrumentalVolume,
    vocalVolume: hasVocalPockets ? 1.0 : DEFAULT_REMUX.vocalVolume,
  };
}

async function loadJsonFromUrl(url: string): Promise<unknown> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`CWALO result download failed (${response.status})`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("CWALO result was not valid JSON");
  }
}

function collectOutputUrls(output: unknown): string[] {
  if (typeof output === "string" && /^https?:\/\//i.test(output)) return [output];
  if (Array.isArray(output)) {
    return output.flatMap((item) => collectOutputUrls(item));
  }
  if (output && typeof output === "object") {
    const row = output as Record<string, unknown>;
    const urls: string[] = [];
    for (const value of Object.values(row)) {
      urls.push(...collectOutputUrls(value));
    }
    return urls;
  }
  return [];
}

/**
 * Prefer `.json` analysis artifacts from the CWALO file list.
 */
export async function resolveCwaloStructureFromOutput(output: unknown): Promise<CwaloStructure> {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const direct = parseCwaloAnalysisJson(output);
    if (direct.sections.length > 0 || direct.bpm != null) {
      return {
        ...direct,
        remux: remuxGainsFromStructure(direct.sections),
        raw: output,
      };
    }
  }

  const urls = collectOutputUrls(output).filter((u) => /\.json($|\?)/i.test(u));
  const candidates = urls.length > 0 ? urls : collectOutputUrls(output);

  for (const url of candidates) {
    try {
      const doc = await loadJsonFromUrl(url);
      const parsed = parseCwaloAnalysisJson(doc);
      if (parsed.sections.length > 0 || parsed.bpm != null || parsed.beats.length > 0) {
        return {
          ...parsed,
          remux: remuxGainsFromStructure(parsed.sections),
          raw: doc,
        };
      }
    } catch (error) {
      console.warn(
        "[GATE_2_CWALO] skip output artifact",
        url,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Soft structure: empty roadmap still lets Demucs proceed with default gains.
  return {
    bpm: null,
    beats: [],
    downbeats: [],
    sections: [],
    durationSeconds: null,
    remux: { ...DEFAULT_REMUX },
    raw: output,
  };
}

/**
 * Gate 2 entry: structure analysis on the Gate 1 audio URL.
 * Uses the pinned CWALO version hash via the Replicate SDK.
 */
export async function analyzeMusicStructureWithCwalo(
  audioUrl: string,
): Promise<CwaloStructure> {
  if (!isHttpAudioUrl(audioUrl)) {
    throw new StudioPipelineError("GATE_2", "Base audio URL was not returned");
  }

  const token = replicateApiKey("CWALO structure analysis");
  const replicate = new Replicate({ auth: token });

  console.warn("[GATE_2_CWALO] dispatch", {
    model: CWALO_MODEL,
    audio: audioUrl.slice(0, 96),
  });

  let output: unknown;
  try {
    // Strict Cog schema: only `music_input` (raw audio URL). Extra keys (demux,
    // audio alias, visualize, …) cause Replicate validation rejection.
    output = await replicate.run(CWALO_MODEL as `${string}/${string}:${string}`, {
      input: {
        music_input: audioUrl,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[GATE_2_CWALO_FAIL]", detail);
    throw new StudioPipelineError("GATE_2", `CWALO structure analysis failed: ${detail.slice(0, 240)}`);
  }

  console.warn("[GATE_2_CWALO_OUTPUT]", typeof output, Array.isArray(output) ? output.length : "");
  const structure = await resolveCwaloStructureFromOutput(output);
  console.warn("[GATE_2_CWALO_STRUCTURE]", {
    bpm: structure.bpm,
    sections: structure.sections.map((s) => `${s.label}@${s.start.toFixed(1)}-${s.end.toFixed(1)}`),
    remux: structure.remux,
  });
  logGateCleared(
    2,
    `CWALO roadmap ready (bpm=${structure.bpm ?? "n/a"}, sections=${structure.sections.length})`,
  );
  return structure;
}
