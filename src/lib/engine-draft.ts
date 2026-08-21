/**
 * Hybrid Engine composer draft, mirrored into sessionStorage.
 *
 * iOS Safari can discard and re-create the whole page during OAuth hops,
 * Stripe/token gateway redirects, or an address-bar resize that trips the
 * renderer (the "white flash"). When the tab comes back the React tree is a
 * fresh mount with empty state, which used to wipe the artist's prompt,
 * lyrics and control settings. This module keeps a tiny snapshot of those
 * inputs so the studio can restore them instantly on the next mount.
 *
 * sessionStorage (not localStorage) is deliberate: the draft belongs to this
 * browsing session/tab only and survives reloads and redirect round-trips,
 * but never leaks into a later unrelated visit.
 */

const KEY = "har:engine-draft:v1";
const TTL_MS = 6 * 60 * 60_000;
const MAX_BYTES = 200_000;

export type EngineDraft = {
  lyrics: string;
  title: string;
  styles: string[];
  withVocals: boolean;
  targetDuration: number;
  bpm: number;
  audioInfluence: number;
  weirdness: number;
  styleInfluence: number;
  vocalPresets: string[];
  voiceId: string;
};

type StoredDraft = EngineDraft & { savedAt: number };

function store(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Reads the draft for this session, or null when absent/expired/corrupt. */
export function readEngineDraft(defaults: EngineDraft): EngineDraft | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > TTL_MS) {
      s.removeItem(KEY);
      return null;
    }
    return {
      lyrics: str(parsed.lyrics),
      title: str(parsed.title),
      styles: strList(parsed.styles),
      withVocals: typeof parsed.withVocals === "boolean" ? parsed.withVocals : defaults.withVocals,
      targetDuration: num(parsed.targetDuration, defaults.targetDuration),
      bpm: num(parsed.bpm, defaults.bpm),
      audioInfluence: num(parsed.audioInfluence, defaults.audioInfluence),
      weirdness: num(parsed.weirdness, defaults.weirdness),
      styleInfluence: num(parsed.styleInfluence, defaults.styleInfluence),
      vocalPresets: strList(parsed.vocalPresets),
      voiceId: str(parsed.voiceId),
    };
  } catch {
    return null;
  }
}

/** Writes the draft. Best-effort: quota or privacy-mode failures are ignored. */
export function writeEngineDraft(draft: EngineDraft): void {
  const s = store();
  if (!s) return;
  try {
    const payload = JSON.stringify({ ...draft, savedAt: Date.now() } satisfies StoredDraft);
    if (payload.length > MAX_BYTES) return;
    s.setItem(KEY, payload);
  } catch {
    // Non-fatal — the draft is a courtesy, never a source of truth.
  }
}

/** Clears the draft (after an explicit reset). */
export function clearEngineDraft(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    // Non-fatal.
  }
}

/** True when the draft holds anything worth restoring. */
export function draftHasContent(draft: EngineDraft): boolean {
  return Boolean(
    draft.lyrics.trim() ||
      draft.title.trim() ||
      draft.styles.length ||
      draft.vocalPresets.length,
  );
}
