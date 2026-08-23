/**
 * Gate 2 — CWALO all-in-one music structure analysis (Replicate).
 *
 * Runs after Gate 1 base audio is ready and before Gate 3 Demucs.
 * Extracts section boundaries, tempo, and remux gain hints so the
 * instrumental bed is never attenuated through transitions / outro.
 */

import Replicate from "replicate";
import { createReadStream } from "node:fs";
import { join } from "node:path";

import { replicateApiKey } from "@/lib/ai-provider.server";
import { StudioPipelineError } from "@/lib/studio-pipeline-error";
import {
  logGateCleared,
  isHttpAudioUrl,
  isPublicHttpAudioUrl,
} from "@/lib/pipeline-contracts";

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

export type CwaloSectionKind = "intro" | "verse" | "chorus" | "bridge" | "outro" | "other";

/** Downstream mastering guide derived from CWALO sections + energy. */
export type CwaloMasterPlan = {
  sections: CwaloSection[];
  energyProfile: number[];
  outroStart: number | null;
  trackEnd: number | null;
  remux: CwaloRemuxGains;
  /** FFmpeg volume= expression (eval=frame); commas pre-escaped for filter_complex. */
  instrumentalVolumeExpr: string | null;
  vocalVolumeExpr: string | null;
  /** Smooth stereo fade exclusively at track_end (2.5s when CWALO end is known). */
  fadeOutSeconds: number;
};

export type CwaloStructure = {
  bpm: number | null;
  beats: number[];
  downbeats: number[];
  sections: CwaloSection[];
  energyProfile: number[];
  outroStart: number | null;
  trackEnd: number | null;
  durationSeconds: number | null;
  remux: CwaloRemuxGains;
  masterPlan: CwaloMasterPlan;
  raw: unknown;
};

/** Gate 5 tail fade when CWALO provides a genuine track_end. */
export const CWALO_TAIL_FADE_SECONDS = 2.5;

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
export function parseCwaloAnalysisJson(
  doc: unknown,
): Omit<CwaloStructure, "raw" | "remux" | "masterPlan"> {
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

  const energyProfile = asNumberArray(
    nested.energy_profile ??
      nested.energyProfile ??
      nested.energies ??
      nested.energy ??
      root.energy_profile ??
      root.energyProfile,
  );

  let durationSeconds =
    asNumber(nested.duration ?? nested.duration_seconds ?? root.duration) ?? null;
  if (durationSeconds == null && sections.length > 0) {
    durationSeconds = Math.max(...sections.map((s) => s.end));
  }

  const outroSection = sections.find((s) => classifyCwaloSection(s.label) === "outro");
  const outroStart =
    asNumber(nested.outro_start ?? nested.outroStart ?? root.outro_start) ??
    outroSection?.start ??
    null;
  const trackEnd =
    asNumber(nested.track_end ?? nested.trackEnd ?? root.track_end) ??
    durationSeconds ??
    (sections.length > 0 ? Math.max(...sections.map((s) => s.end)) : null);

  return {
    bpm,
    beats,
    downbeats,
    sections,
    energyProfile,
    outroStart,
    trackEnd,
    durationSeconds,
  };
}

export function classifyCwaloSection(label: string): CwaloSectionKind {
  const normalized = normalizeLabel(label);
  if (normalized.includes("intro")) return "intro";
  if (normalized.includes("outro") || normalized.includes("ending")) return "outro";
  if (normalized.includes("chorus") || normalized.includes("hook") || normalized.includes("drop")) {
    return "chorus";
  }
  if (normalized.includes("bridge") || normalized.includes("break")) return "bridge";
  if (
    normalized.includes("verse") ||
    normalized.includes("pre chorus") ||
    normalized.includes("prechorus") ||
    normalized.includes("refrain")
  ) {
    return "verse";
  }
  return "other";
}

/** Per-section remux targets: full band on chorus/outro; vocal pocket on verse. */
export function sectionRemuxGains(kind: CwaloSectionKind): CwaloRemuxGains {
  switch (kind) {
    case "verse":
      // Clear vocal pocket — slight bed dip, vocal lift (bed never hollows out).
      return { instrumentalVolume: 0.88, vocalVolume: 1.12 };
    case "chorus":
    case "outro":
      return { instrumentalVolume: 1.0, vocalVolume: 1.0 };
    case "bridge":
      return { instrumentalVolume: 1.0, vocalVolume: 0.95 };
    case "intro":
      return { instrumentalVolume: 1.0, vocalVolume: 0.75 };
    default:
      return { ...DEFAULT_REMUX };
  }
}

function formatGain(value: number): string {
  const clamped = Math.max(0.5, Math.min(1.25, value));
  return Number.isInteger(clamped) ? clamped.toFixed(1) : clamped.toFixed(2);
}

/**
 * Build an FFmpeg volume expression from CWALO section markers.
 * Commas are escaped for use inside `-filter_complex`.
 */
export function buildSectionVolumeExpression(
  sections: CwaloSection[],
  role: "instrumental" | "vocal",
  energyProfile: number[] = [],
): string | null {
  if (sections.length === 0) return null;
  const sorted = [...sections].sort((a, b) => a.start - b.start);
  const energyMedian =
    energyProfile.length > 0
      ? [...energyProfile].sort((a, b) => a - b)[Math.floor(energyProfile.length / 2)]!
      : null;

  let expr = "1.0";
  for (let i = sorted.length - 1; i >= 0; i--) {
    const section = sorted[i]!;
    const kind = classifyCwaloSection(section.label);
    let gains = sectionRemuxGains(kind);
    // High-energy frames keep full instrumentation even inside verse pockets.
    if (energyMedian != null && energyProfile[i] != null && energyProfile[i]! >= energyMedian) {
      gains = {
        instrumentalVolume: Math.max(gains.instrumentalVolume, 1.0),
        vocalVolume: gains.vocalVolume,
      };
    }
    if (kind === "chorus" || kind === "outro") {
      gains = { instrumentalVolume: 1.0, vocalVolume: gains.vocalVolume };
    }
    const gain = formatGain(
      role === "instrumental" ? gains.instrumentalVolume : gains.vocalVolume,
    );
    const start = Number(section.start.toFixed(3));
    const end = Number(section.end.toFixed(3));
    expr = `if(between(t\\,${start}\\,${end})\\,${gain}\\,${expr})`;
  }
  return expr;
}

/** Remux gains: keep bed solid through outro/transition; slight vocal lift in pockets. */
export function remuxGainsFromStructure(sections: CwaloSection[]): CwaloRemuxGains {
  if (sections.length === 0) return { ...DEFAULT_REMUX };

  const labels = sections.map((s) => normalizeLabel(s.label));
  const protectsBed = labels.some((l) =>
    BED_PROTECT_LABELS.some((needle) => l.includes(needle)),
  );
  const hasVocalPockets = labels.some((l) =>
    VOCAL_POCKET_LABELS.some((needle) => l.includes(needle)),
  );

  return {
    instrumentalVolume: protectsBed ? 1.0 : DEFAULT_REMUX.instrumentalVolume,
    vocalVolume: hasVocalPockets ? 1.0 : DEFAULT_REMUX.vocalVolume,
  };
}

/** Build the Gate 5 mastering plan from parsed CWALO fields. */
export function buildCwaloMasterPlan(
  parsed: Omit<CwaloStructure, "raw" | "remux" | "masterPlan">,
): CwaloMasterPlan {
  const remux = remuxGainsFromStructure(parsed.sections);
  const trackEnd = parsed.trackEnd ?? parsed.durationSeconds;
  const hasDynamic = parsed.sections.length > 0;
  return {
    sections: parsed.sections,
    energyProfile: parsed.energyProfile,
    outroStart: parsed.outroStart,
    trackEnd,
    remux,
    instrumentalVolumeExpr: hasDynamic
      ? buildSectionVolumeExpression(parsed.sections, "instrumental", parsed.energyProfile)
      : null,
    vocalVolumeExpr: hasDynamic
      ? buildSectionVolumeExpression(parsed.sections, "vocal", parsed.energyProfile)
      : null,
    fadeOutSeconds: trackEnd != null && trackEnd > CWALO_TAIL_FADE_SECONDS
      ? CWALO_TAIL_FADE_SECONDS
      : CWALO_TAIL_FADE_SECONDS,
  };
}

function finalizeStructure(parsed: Omit<CwaloStructure, "raw" | "remux" | "masterPlan">, raw: unknown): CwaloStructure {
  const masterPlan = buildCwaloMasterPlan(parsed);
  return {
    ...parsed,
    remux: masterPlan.remux,
    masterPlan,
    raw,
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
      return finalizeStructure(direct, output);
    }
  }

  const urls = collectOutputUrls(output).filter((u) => /\.json($|\?)/i.test(u));
  const candidates = urls.length > 0 ? urls : collectOutputUrls(output);

  for (const url of candidates) {
    try {
      const doc = await loadJsonFromUrl(url);
      const parsed = parseCwaloAnalysisJson(doc);
      if (parsed.sections.length > 0 || parsed.bpm != null || parsed.beats.length > 0) {
        return finalizeStructure(parsed, doc);
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
  return finalizeStructure(
    {
      bpm: null,
      beats: [],
      downbeats: [],
      sections: [],
      energyProfile: [],
      outroStart: null,
      trackEnd: null,
      durationSeconds: null,
    },
    output,
  );
}

/**
 * Resolve a Replicate-reachable `music_input`:
 * 1) public CDN URL as-is
 * 2) otherwise stream local vault audio via createReadStream → replicate.files.create
 *    and return the uploaded file's public URL (never localhost)
 */
export async function resolveCwaloMusicInput(
  replicate: Replicate,
  audioUrl: string,
): Promise<string> {
  if (isPublicHttpAudioUrl(audioUrl)) {
    return audioUrl;
  }

  console.warn("[GATE_2_CWALO] non-public audio URL — uploading to Replicate Files", {
    audio: audioUrl.slice(0, 120),
  });

  let bytes: Buffer | null = null;
  let fileName = "gate1-base.mp3";
  let diskPath: string | null = null;

  try {
    const parsed = new URL(audioUrl);
    const leaf = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    if (leaf && /local-vault/i.test(parsed.pathname)) {
      fileName = leaf;
      diskPath = join(process.cwd(), ".data", "local-vault", leaf);
    }
  } catch {
    // fall through
  }

  // Preferred path: stream from disk into replicate.files.create.
  // The JS SDK types only accept Buffer|Blob, so we buffer the ReadStream.
  if (diskPath) {
    try {
      const stream = createReadStream(diskPath);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (chunks.length > 0) bytes = Buffer.concat(chunks);
    } catch (error) {
      console.warn(
        "[GATE_2_CWALO] local vault stream miss — falling back to HTTP fetch",
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (!bytes) {
    const response = await fetch(audioUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new Error(`Could not read Gate 1 audio for CWALO upload (${response.status})`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
  }

  if (bytes.byteLength < 1024) {
    throw new Error("Gate 1 audio was empty — cannot run CWALO");
  }

  const file = await replicate.files.create(bytes, {
    filename: fileName,
    source: "cwalo-gate2",
  });
  // Prediction JSON needs a public URL; FileObject.urls.get is what cloud workers fetch.
  const uploaded = typeof file?.urls?.get === "string" ? file.urls.get : null;
  if (!uploaded || !isPublicHttpAudioUrl(uploaded)) {
    throw new Error("Replicate files.create returned no public URL for CWALO music_input");
  }
  console.warn("[GATE_2_CWALO] uploaded local audio to Replicate Files", {
    fileId: file.id,
    bytes: bytes.byteLength,
    url: uploaded.slice(0, 96),
  });
  return uploaded;
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

  const musicInput = await resolveCwaloMusicInput(replicate, audioUrl);
  if (!isPublicHttpAudioUrl(musicInput)) {
    throw new StudioPipelineError(
      "GATE_2",
      "CWALO music_input must be a public URL (CDN or Replicate Files) — refused localhost",
    );
  }

  console.warn("[GATE_2_CWALO] dispatch", {
    model: CWALO_MODEL,
    audio: musicInput.slice(0, 96),
    uploaded: musicInput !== audioUrl,
  });

  let output: unknown;
  try {
    // Strict Cog schema: only `music_input` (public URL or Replicate file URL).
    output = await replicate.run(CWALO_MODEL as `${string}/${string}:${string}`, {
      input: {
        music_input: musicInput,
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
    energyPoints: structure.energyProfile.length,
    outroStart: structure.outroStart,
    trackEnd: structure.trackEnd,
    remux: structure.remux,
    dynamicRemux: Boolean(structure.masterPlan.instrumentalVolumeExpr),
  });
  logGateCleared(
    2,
    `CWALO roadmap ready (bpm=${structure.bpm ?? "n/a"}, sections=${structure.sections.length})`,
  );
  return structure;
}
