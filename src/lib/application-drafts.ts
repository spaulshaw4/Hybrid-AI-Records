/**
 * Per-package application drafts.
 *
 * Each /start package option (and single/bundle mode) autosaves into its own
 * slot, so an artist can have several in-progress applications side by side
 * and resume whichever one they want.
 *
 * Drafts are encrypted at rest: the JSON payload is sealed with an AES-GCM key
 * that lives non-extractably in IndexedDB on this device (see draft-crypto),
 * so localStorage only ever holds ciphertext. Reads and writes are therefore
 * async. Legacy plaintext drafts are read once and re-sealed on next save.
 */

import { decryptString, encryptString, isEncryptedRecord } from "@/lib/draft-crypto";

export type ApplicationDraft = {
  artist: string;
  email: string;
  pkg: string;
  link: string;
  notes: string;
  ack: boolean;
  savedAt: number;
};

export const DEFAULT_DRAFT_SCOPE = "general";
const PREFIX = "hybrid.application.draft.v1";
/** Legacy single-slot key kept so older in-progress drafts still resume once. */
const LEGACY_KEY = "hybrid.application.draft.v1";

const keyFor = (scope: string) => `${PREFIX}:${scope || DEFAULT_DRAFT_SCOPE}`;

const parseDraft = (raw: string | null): ApplicationDraft | null => {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<ApplicationDraft>;
    if (typeof d !== "object" || d === null) return null;
    return {
      artist: String(d.artist ?? ""),
      email: String(d.email ?? ""),
      pkg: String(d.pkg ?? ""),
      link: String(d.link ?? ""),
      notes: String(d.notes ?? ""),
      ack: Boolean(d.ack),
      savedAt: Number(d.savedAt ?? 0),
    };
  } catch {
    return null;
  }
};

/** Decode a stored record, transparently handling sealed and legacy values. */
const decodeRecord = async (raw: string | null): Promise<ApplicationDraft | null> => {
  if (!raw) return null;
  if (isEncryptedRecord(raw)) return parseDraft(await decryptString(raw));
  return parseDraft(raw);
};

const encodeRecord = async (d: ApplicationDraft): Promise<string> => {
  const json = JSON.stringify(d);
  return (await encryptString(json)) ?? json;
};

export const hasDraftContent = (d: ApplicationDraft) =>
  Boolean(d.artist.trim() || d.email.trim() || d.link.trim() || d.notes.trim());

export const readDraft = async (scope: string): Promise<ApplicationDraft | null> => {
  if (typeof window === "undefined") return null;
  try {
    const own = await decodeRecord(window.localStorage.getItem(keyFor(scope)));
    if (own) return own;
    // One-time migration from the old shared slot.
    const legacy = await decodeRecord(window.localStorage.getItem(LEGACY_KEY));
    if (legacy && hasDraftContent(legacy)) {
      window.localStorage.setItem(keyFor(scope), await encodeRecord(legacy));
      window.localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
};

export const writeDraft = async (scope: string, d: ApplicationDraft): Promise<boolean> => {
  try {
    window.localStorage.setItem(keyFor(scope), await encodeRecord(d));
    return true;
  } catch {
    return false;
  }
};

export const removeDraft = (scope: string) => {
  try {
    window.localStorage.removeItem(keyFor(scope));
  } catch {
    /* storage unavailable — nothing to clear */
  }
};

export type SavedDraftEntry = {
  scope: string;
  /** Package slug portion of the scope, e.g. "foundation". */
  slug: string;
  /** "single" | "bundle" when present in the scope. */
  mode: string;
  draft: ApplicationDraft;
};

/** Every in-progress draft on this device, newest first. */
export const listDrafts = async (): Promise<SavedDraftEntry[]> => {
  if (typeof window === "undefined") return [];
  const out: SavedDraftEntry[] = [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(`${PREFIX}:`)) keys.push(key);
    }
    for (const key of keys) {
      const draft = await decodeRecord(window.localStorage.getItem(key));
      if (!draft || !hasDraftContent(draft)) continue;
      const scope = key.slice(PREFIX.length + 1);
      const [slug = scope, mode = ""] = scope.split(":");
      out.push({ scope, slug, mode, draft });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.draft.savedAt - a.draft.savedAt);
};


export const draftScopeFor = (slug: string, mode: string) => `${slug}:${mode}`;
