/**
 * Draft version history.
 *
 * Every autosave contributes a snapshot so an artist can roll back to an
 * earlier version of an in-progress application. History lives on this device
 * only and is encrypted at rest with the same non-extractable AES-GCM key used
 * for the drafts themselves (see draft-crypto).
 */

import type { ApplicationDraft } from "@/lib/application-drafts";
import { decryptString, encryptString, isEncryptedRecord } from "@/lib/draft-crypto";

export type DraftSnapshot = ApplicationDraft & {
  /** Stable id for list keys and restore actions. */
  id: string;
  /** When the snapshot was captured. */
  at: number;
};

const PREFIX = "hybrid.application.history.v1";
/** Most recent snapshots kept per slot. */
export const MAX_SNAPSHOTS = 20;
/** Snapshots closer together than this are collapsed into the newest one. */
export const MIN_SNAPSHOT_GAP_MS = 20_000;

const keyFor = (scope: string) => `${PREFIX}:${scope || "general"}`;

const fieldsOf = (d: ApplicationDraft) =>
  JSON.stringify([d.artist, d.email, d.pkg, d.link, d.notes, d.ack]);

const parse = (raw: string | null): DraftSnapshot[] => {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s): DraftSnapshot => {
        const d = (s ?? {}) as Partial<DraftSnapshot>;
        return {
          id: String(d.id ?? `${d.at ?? 0}`),
          at: Number(d.at ?? d.savedAt ?? 0),
          artist: String(d.artist ?? ""),
          email: String(d.email ?? ""),
          pkg: String(d.pkg ?? ""),
          link: String(d.link ?? ""),
          notes: String(d.notes ?? ""),
          ack: Boolean(d.ack),
          savedAt: Number(d.savedAt ?? d.at ?? 0),
        };
      })
      .filter((s) => s.at > 0)
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
};

const load = async (scope: string): Promise<DraftSnapshot[]> => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(scope));
    if (!raw) return [];
    return parse(isEncryptedRecord(raw) ? await decryptString(raw) : raw);
  } catch {
    return [];
  }
};

const save = async (scope: string, list: DraftSnapshot[]) => {
  try {
    const json = JSON.stringify(list.slice(0, MAX_SNAPSHOTS));
    window.localStorage.setItem(keyFor(scope), (await encryptString(json)) ?? json);
    return true;
  } catch {
    return false;
  }
};

/** Snapshots for a slot, newest first. */
export const listSnapshots = (scope: string): Promise<DraftSnapshot[]> => load(scope);

/**
 * Capture a snapshot after an autosave.
 *
 * Skips no-op saves (identical field values) and collapses rapid keystroke
 * saves so the history stays readable instead of one entry per character.
 */
export const recordSnapshot = async (
  scope: string,
  draft: ApplicationDraft,
): Promise<DraftSnapshot[]> => {
  const list = await load(scope);
  const at = draft.savedAt || Date.now();
  const newest = list[0];
  if (newest && fieldsOf(newest) === fieldsOf(draft)) return list;

  const entry: DraftSnapshot = {
    ...draft,
    id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
    at,
  };
  // Replace the newest entry when it is only seconds old (still the same edit burst).
  const next =
    newest && at - newest.at < MIN_SNAPSHOT_GAP_MS ? [entry, ...list.slice(1)] : [entry, ...list];
  const trimmed = next.slice(0, MAX_SNAPSHOTS);
  await save(scope, trimmed);
  return trimmed;
};

/** Drop the whole history for a slot (used when a draft is discarded/submitted). */
export const clearHistory = (scope: string) => {
  try {
    window.localStorage.removeItem(keyFor(scope));
  } catch {
    /* storage unavailable — nothing to clear */
  }
};

/** Remove one snapshot by id. */
export const deleteSnapshot = async (scope: string, id: string): Promise<DraftSnapshot[]> => {
  const list = (await load(scope)).filter((s) => s.id !== id);
  await save(scope, list);
  return list;
};

/** Human summary of what changed versus the snapshot that came after it. */
export const describeChange = (snapshot: DraftSnapshot, previous?: DraftSnapshot): string => {
  if (!previous) return "First saved version";
  const changed: string[] = [];
  if (snapshot.artist !== previous.artist) changed.push("artist");
  if (snapshot.email !== previous.email) changed.push("email");
  if (snapshot.pkg !== previous.pkg) changed.push("package");
  if (snapshot.link !== previous.link) changed.push("link");
  if (snapshot.notes !== previous.notes) changed.push("notes");
  if (snapshot.ack !== previous.ack) changed.push("agreement");
  if (changed.length === 0) return "No field changes";
  return `Changed ${changed.join(", ")}`;
};
