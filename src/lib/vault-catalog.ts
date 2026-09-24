/**
 * Catalog display helpers for the Audio Vault table and conductor card.
 * Keys, 96-bar / 210s form, and local-worker WAV / MP3 / ZIP URLs.
 */

import { defaultKeyForGenre } from "@/lib/DeepIsolationPlacement";

export const DEFAULT_CATALOG_DURATION_SEC = 210;
export const FULL_SONG_BARS = 96;
export const WORKER_SESSIONS_KEY = "hybrid.worker.sessions";

export type CatalogStatus = "processing" | "completed" | "failed";

export type WorkerDownloadUrls = {
  wavUrl: string;
  mp3Url: string;
  zipUrl: string;
};

export type RelationalSnap = {
  kickBassAligned: boolean | null;
  snaps: number | null;
  medianShiftMs: number | null;
};

const SESSION_RE = /^ht_[a-f0-9]{8,}$/i;

export function isWorkerSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_RE.test(value.trim());
}

/** `G_major` / `g major` / `G` → `G Major`. */
export function formatCatalogKey(raw: string | null | undefined): string {
  const text = (raw || "").trim();
  if (!text) return "";
  const normalized = text.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const match = normalized.match(/^([a-g](?:#|b|♯|♭)?)\s*(major|minor|maj|min|m)?$/i);
  if (!match) {
    return normalized
      .split(" ")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }
  const note = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
  const modeRaw = (match[2] || "major").toLowerCase();
  const mode = modeRaw === "m" || modeRaw === "min" || modeRaw === "minor" ? "Minor" : "Major";
  return `${note} ${mode}`;
}

export function resolveCatalogKey(
  style: string,
  title = "",
  explicit?: string | null,
): string {
  const locked = formatCatalogKey(explicit);
  if (locked) return locked;
  return formatCatalogKey(defaultKeyForGenre(style || "pop", title));
}

export function resolveCatalogGenre(style: string): string {
  const trimmed = style.trim();
  if (!trimmed || trimmed.toLowerCase() === "custom") return "Custom";
  const first = trimmed.split(",")[0]?.trim() || trimmed;
  return first.replace(/\s+/g, " ");
}

export function resolveCatalogDurationSec(value: unknown, fallback = DEFAULT_CATALOG_DURATION_SEC): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

export function formatDurationSeconds(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  return `${safe}s`;
}

export function barsForCatalog(durationSec: number, bpm = 110, maxBars = FULL_SONG_BARS): number {
  const bars = Math.round((durationSec * bpm) / 240);
  return Math.max(1, Math.min(maxBars, Number.isFinite(bars) ? bars : maxBars));
}

export function currentBarIndex(currentSec: number, durationSec: number, bars = FULL_SONG_BARS): number {
  if (!(durationSec > 0) || !(currentSec >= 0)) return 1;
  const ratio = Math.min(1, Math.max(0, currentSec / durationSec));
  return Math.min(bars, Math.max(1, Math.floor(ratio * bars) + 1));
}

export function workerStreamUrl(filename: string): string {
  const name = filename.replace(/^\/+/, "").split("/").pop() || filename;
  return `/api/stream/${encodeURIComponent(name)}`;
}

export function workerDownloadUrls(
  sessionId: string,
  job?: {
    master_url?: string | null;
    mp3_url?: string | null;
    zip_url?: string | null;
    audio_filename?: string | null;
  },
): WorkerDownloadUrls {
  const id = sessionId.trim();
  return {
    wavUrl: job?.master_url || (job?.audio_filename ? workerStreamUrl(job.audio_filename) : workerStreamUrl(`${id}_master.wav`)),
    mp3Url: job?.mp3_url || workerStreamUrl(`${id}_master.mp3`),
    zipUrl: job?.zip_url || workerStreamUrl(`${id}_stems_bundle.zip`),
  };
}

/** Finished-record URLs only — WAV master first, MP3 as stream fallback. */
export function vaultMasterUrls(row: {
  id: string;
  masterUrl?: string;
  mp3Url?: string;
}): { wavUrl: string; streamUrl: string; fallbackUrl: string } {
  if (isWorkerSessionId(row.id)) {
    const urls = workerDownloadUrls(row.id);
    return { wavUrl: urls.wavUrl, streamUrl: urls.wavUrl, fallbackUrl: urls.mp3Url };
  }
  const master = (row.masterUrl || "").trim();
  const mp3 = (row.mp3Url || "").trim();
  const wavUrl = /\.wav(\?|$)/i.test(master) ? master : "";
  const streamUrl = wavUrl || mp3 || master;
  return { wavUrl: wavUrl || master, streamUrl, fallbackUrl: mp3 || master };
}

export function rememberWorkerSession(sessionId: string): void {
  if (typeof window === "undefined" || !isWorkerSessionId(sessionId)) return;
  try {
    const next = new Set(listRememberedWorkerSessions());
    next.add(sessionId.trim());
    window.localStorage.setItem(WORKER_SESSIONS_KEY, JSON.stringify([...next].slice(-40)));
  } catch {
    /* ignore quota */
  }
}

export function listRememberedWorkerSessions(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WORKER_SESSIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => isWorkerSessionId(id));
  } catch {
    return [];
  }
}

export function collectWorkerSessionIds(extra: readonly string[] = []): string[] {
  const found = new Set<string>();
  for (const id of [...listRememberedWorkerSessions(), ...extra]) {
    if (isWorkerSessionId(id)) found.add(id.trim());
  }
  if (typeof window === "undefined") return [...found];
  try {
    const recent = window.localStorage.getItem("hybrid.studio.recent");
    const rows = recent ? JSON.parse(recent) : [];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        for (const key of ["id", "taskId", "sessionId", "session_id"]) {
          const value = rec[key];
          if (isWorkerSessionId(value)) found.add(value.trim());
        }
      }
    }
  } catch {
    /* ignore */
  }
  return [...found];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractSongPlanKey(songPlan: unknown): string {
  const plan = asRecord(songPlan);
  if (!plan) return "";
  const meta = asRecord(plan.core_metadata);
  const key = plan.key ?? plan.key_spec ?? plan.musical_key ?? meta?.key;
  if (typeof key !== "string" || !key.trim()) return "";
  const raw = key.trim();
  if (/\b(major|minor|maj|min)\b/i.test(raw) || /_(major|minor)$/i.test(raw)) {
    return raw;
  }
  const scale = plan.scale ?? plan.mode ?? meta?.scale;
  if (typeof scale === "string" && scale.trim()) {
    return `${raw}_${scale.trim()}`;
  }
  return raw;
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Seconds from master metadata, then song_plan bars, then requested bars. */
export function durationSecFromWorkerJob(job: {
  master_duration_sec?: number | null;
  requested_bars?: number | null;
  requested_bpm?: number | null;
  song_plan?: unknown;
}): number | null {
  const direct = positiveNumber(job.master_duration_sec);
  if (direct) return Math.round(direct);
  const plan = asRecord(job.song_plan);
  const bpm =
    positiveNumber(job.requested_bpm) ||
    positiveNumber(plan?.bpm) ||
    110;
  const planBars = positiveNumber(plan?.total_bars);
  if (planBars) return Math.round((planBars * 240) / bpm);
  const requestedBars = positiveNumber(job.requested_bars);
  if (requestedBars) return Math.round((requestedBars * 240) / bpm);
  return null;
}

export function extractChordProgression(songPlan: unknown, fallbackKey = "G Major"): string[] {
  const plan = asRecord(songPlan);
  if (plan) {
    const top = plan.chord_progression;
    if (Array.isArray(top) && top.every((c) => typeof c === "string") && top.length) {
      return top as string[];
    }
    const sections = plan.sections;
    if (Array.isArray(sections)) {
      for (const section of sections) {
        const rec = asRecord(section);
        const chords = rec?.chord_progression;
        if (Array.isArray(chords) && chords.every((c) => typeof c === "string") && chords.length) {
          return chords as string[];
        }
      }
    }
    const roadmap = plan.harmonic_roadmap;
    if (Array.isArray(roadmap)) {
      const chords: string[] = [];
      for (const step of roadmap) {
        const rec = asRecord(step);
        const chord = rec?.chord;
        if (typeof chord === "string" && chord && !chords.includes(chord)) chords.push(chord);
        if (chords.length >= 8) break;
      }
      if (chords.length) return chords;
    }
  }
  return defaultChordsForKey(fallbackKey);
}

export function defaultChordsForKey(keyLabel: string): string[] {
  const formatted = formatCatalogKey(keyLabel) || "G Major";
  const [note = "G", mode = "Major"] = formatted.split(" ");
  if (mode === "Minor") {
    return [`${note}m`, relativeMajor(note), `${note}m`, "D"];
  }
  return [note, nextPerfectFourth(note), `${relativeMinor(note)}m`, "D"].filter(Boolean);
}

function nextPerfectFourth(note: string): string {
  const circle = ["C", "F", "Bb", "Eb", "Ab", "Db", "Gb", "B", "E", "A", "D", "G"];
  const i = circle.findIndex((n) => n.toLowerCase() === note.toLowerCase());
  return i >= 0 ? circle[(i + 1) % circle.length]! : "C";
}

function relativeMinor(note: string): string {
  const map: Record<string, string> = {
    C: "A",
    G: "E",
    D: "B",
    A: "F#",
    E: "C#",
    B: "G#",
    F: "D",
  };
  return map[note] || "E";
}

function relativeMajor(note: string): string {
  const map: Record<string, string> = {
    A: "C",
    E: "G",
    B: "D",
    "F#": "A",
    "C#": "E",
    "G#": "B",
    D: "F",
  };
  return map[note] || "C";
}

export function formatChordArrow(chords: readonly string[]): string {
  if (!chords.length) return "—";
  return chords.join(" → ");
}

const RELATIONAL_RE =
  /\[RELATIONAL\][^\n]*kick_bass_aligned[=:]?\s*(true|false|1|0)[^\n]*snaps[=:]?\s*(-?\d+)[^\n]*median_shift_ms[=:]?\s*(-?[\d.]+)/i;

export function parseRelationalSnap(source: unknown): RelationalSnap | null {
  const rec = asRecord(source);
  if (rec) {
    const nested = asRecord(rec.relational) ?? rec;
    const aligned = nested.kick_bass_aligned ?? nested.kickBassAligned;
    const snaps = nested.snaps ?? nested.snap_count ?? nested.snapCount;
    const shift = nested.median_shift_ms ?? nested.medianShiftMs;
    if (aligned !== undefined || snaps !== undefined || shift !== undefined) {
      return {
        kickBassAligned:
          typeof aligned === "boolean" ? aligned : aligned === 1 || aligned === "true" ? true : aligned == null ? null : false,
        snaps: Number.isFinite(Number(snaps)) ? Number(snaps) : null,
        medianShiftMs: Number.isFinite(Number(shift)) ? Number(shift) : null,
      };
    }
    for (const key of ["note", "log", "logs", "detail"]) {
      const text = nested[key];
      if (typeof text === "string") {
        const parsed = parseRelationalSnap(text);
        if (parsed) return parsed;
      }
    }
  }
  if (typeof source === "string") {
    const match = source.match(RELATIONAL_RE);
    if (!match) return null;
    return {
      kickBassAligned: match[1] === "true" || match[1] === "1",
      snaps: Number(match[2]),
      medianShiftMs: Number(match[3]),
    };
  }
  return null;
}

export type WorkerJobPayload = {
  session_id?: string;
  status?: string;
  genre_hint?: string | null;
  error?: string | null;
  note?: string | null;
  audio_filename?: string | null;
  created_at?: string;
  updated_at?: string;
  master_url?: string | null;
  mp3_url?: string | null;
  zip_url?: string | null;
  song_plan?: unknown;
  requested_bars?: number | null;
  requested_bpm?: number | null;
  master_duration_sec?: number | null;
  relational?: unknown;
};

export function workerJobToVaultPayload(job: WorkerJobPayload): {
  id: string;
  title: string;
  style: string;
  status: CatalogStatus;
  master_url: string | null;
  instrumental_url: string | null;
  vocal_url: string | null;
  raw_audio_url: string | null;
  created_at: string;
  artist_name: string;
  album_name: string;
  musical_key: string;
  duration_sec: number;
  mp3_url: string | null;
  zip_url: string | null;
} | null {
  const id = typeof job.session_id === "string" ? job.session_id.trim() : "";
  if (!id) return null;
  const statusRaw = (job.status || "").toLowerCase();
  const status: CatalogStatus =
    statusRaw === "completed" ? "completed" : statusRaw === "failed" ? "failed" : "processing";
  const urls = workerDownloadUrls(id, job);
  const plan = asRecord(job.song_plan);
  const title =
    (typeof plan?.title === "string" && plan.title.trim()) ||
    (typeof job.genre_hint === "string" && job.genre_hint.trim()) ||
    id;
  const style = (job.genre_hint || "Custom").trim() || "Custom";
  const duration = durationSecFromWorkerJob(job) ?? DEFAULT_CATALOG_DURATION_SEC;
  return {
    id,
    title,
    style,
    status,
    master_url: status === "completed" ? urls.wavUrl : null,
    instrumental_url: null,
    vocal_url: null,
    raw_audio_url: null,
    created_at: job.created_at || job.updated_at || new Date().toISOString(),
    artist_name: "Hybrid Engine",
    album_name: "Local Releases",
    musical_key: extractSongPlanKey(job.song_plan),
    duration_sec: duration,
    mp3_url: status === "completed" ? urls.mp3Url : null,
    zip_url: status === "completed" ? urls.zipUrl : null,
  };
}

export async function fetchWorkerJob(sessionId: string): Promise<WorkerJobPayload | null> {
  if (!isWorkerSessionId(sessionId)) return null;
  try {
    const response = await fetch(`/api/tracks/status/${encodeURIComponent(sessionId)}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as WorkerJobPayload;
    if (body.session_id) rememberWorkerSession(body.session_id);
    return body;
  } catch {
    return null;
  }
}

export async function fetchLocalReleaseSessionIds(): Promise<string[]> {
  try {
    const response = await fetch("/api/local-releases", { headers: { Accept: "application/json" } });
    if (!response.ok) return [];
    const body = (await response.json()) as { sessions?: unknown };
    if (!Array.isArray(body.sessions)) return [];
    return body.sessions.filter((id): id is string => isWorkerSessionId(id));
  } catch {
    return [];
  }
}

export async function fetchWorkerVaultPayloads(extraIds: readonly string[] = []) {
  const published = await fetchLocalReleaseSessionIds();
  const publishedSet = new Set(published);
  for (const id of published) rememberWorkerSession(id);
  const ids = collectWorkerSessionIds([...extraIds, ...published]);
  const rows = await Promise.all(
    ids.map(async (id) => {
      const job = await fetchWorkerJob(id);
      if (job) return workerJobToVaultPayload(job);
      if (!publishedSet.has(id)) return null;
      return workerJobToVaultPayload({
        session_id: id,
        status: "completed",
        genre_hint: "Local Release",
        audio_filename: `${id}_master.wav`,
      });
    }),
  );
  return rows.filter((row): row is NonNullable<typeof row> => row !== null);
}
