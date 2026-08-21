/**
 * Configurable draft expiration.
 *
 * Saved applications that haven't been touched for the configured retention
 * window are swept automatically: either archived (kept encrypted in a
 * separate slot the artist can restore from) or deleted outright, depending on
 * the chosen policy. Archived copies use the same AES-GCM sealing as live
 * drafts, so localStorage still only ever holds ciphertext.
 */

import {
  listDrafts,
  removeDraft,
  writeDraft,
  type ApplicationDraft,
  type SavedDraftEntry,
} from "@/lib/application-drafts";
import { clearHistory } from "@/lib/draft-history";
import { decryptString, encryptString, isEncryptedRecord } from "@/lib/draft-crypto";

export type RetentionAction = "archive" | "delete";

export type RetentionPolicy = {
  /** Days of inactivity before a draft expires. 0 = never expire. */
  days: number;
  action: RetentionAction;
};

export const RETENTION_CHOICES = [7, 30, 90, 180, 0] as const;

export const DEFAULT_RETENTION: RetentionPolicy = { days: 90, action: "archive" };

const SETTINGS_KEY = "hybrid.application.retention.v1";
const ARCHIVE_PREFIX = "hybrid.application.archive.v1";
const DAY_MS = 86_400_000;

export const retentionLabel = (days: number) =>
  days === 0 ? "Never expire" : days === 1 ? "After 1 day" : `After ${days} days`;

export const readRetention = (): RetentionPolicy => {
  if (typeof window === "undefined") return DEFAULT_RETENTION;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_RETENTION;
    const parsed = JSON.parse(raw) as Partial<RetentionPolicy>;
    const days = Number(parsed.days);
    return {
      days: Number.isFinite(days) && days >= 0 ? days : DEFAULT_RETENTION.days,
      action: parsed.action === "delete" ? "delete" : "archive",
    };
  } catch {
    return DEFAULT_RETENTION;
  }
};

export const writeRetention = (policy: RetentionPolicy) => {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(policy));
  } catch {
    /* storage unavailable — keep in-memory default */
  }
};

export type ArchivedDraftEntry = SavedDraftEntry & { archivedAt: number };

const archiveKey = (scope: string) => `${ARCHIVE_PREFIX}:${scope}`;

const decodeArchive = async (
  raw: string | null,
): Promise<{ draft: ApplicationDraft; archivedAt: number } | null> => {
  if (!raw) return null;
  try {
    const json = isEncryptedRecord(raw) ? await decryptString(raw) : raw;
    if (!json) return null;
    const parsed = JSON.parse(json) as { draft?: ApplicationDraft; archivedAt?: number };
    if (!parsed || typeof parsed.draft !== "object" || parsed.draft === null) return null;
    return { draft: parsed.draft as ApplicationDraft, archivedAt: Number(parsed.archivedAt ?? 0) };
  } catch {
    return null;
  }
};

/** Move one draft into the encrypted archive slot. */
export const archiveDraft = async (entry: SavedDraftEntry): Promise<boolean> => {
  try {
    const json = JSON.stringify({ draft: entry.draft, archivedAt: Date.now() });
    window.localStorage.setItem(archiveKey(entry.scope), (await encryptString(json)) ?? json);
    removeDraft(entry.scope);
    clearHistory(entry.scope);
    return true;
  } catch {
    return false;
  }
};

export const listArchivedDrafts = async (): Promise<ArchivedDraftEntry[]> => {
  if (typeof window === "undefined") return [];
  const out: ArchivedDraftEntry[] = [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(`${ARCHIVE_PREFIX}:`)) keys.push(key);
    }
    for (const key of keys) {
      const record = await decodeArchive(window.localStorage.getItem(key));
      if (!record) continue;
      const scope = key.slice(ARCHIVE_PREFIX.length + 1);
      const [slug = scope, mode = ""] = scope.split(":");
      out.push({ scope, slug, mode, draft: record.draft, archivedAt: record.archivedAt });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.archivedAt - a.archivedAt);
};

export const removeArchivedDraft = (scope: string) => {
  try {
    window.localStorage.removeItem(archiveKey(scope));
  } catch {
    /* nothing to clear */
  }
};

/** Put an archived draft back into the live draft slot. */
export const restoreArchivedDraft = async (
  entry: ArchivedDraftEntry,
): Promise<ApplicationDraft | null> => {
  const draft = { ...entry.draft, savedAt: Date.now() };
  const ok = await writeDraft(entry.scope, draft);
  if (!ok) return null;
  removeArchivedDraft(entry.scope);
  return draft;
};

export type SweepResult = { archived: number; deleted: number; scopes: string[] };

export const isExpired = (draft: ApplicationDraft, policy: RetentionPolicy, now = Date.now()) =>
  policy.days > 0 && now - draft.savedAt > policy.days * DAY_MS;

/**
 * Apply the retention policy to every saved draft on this device.
 * `keepScopes` protects drafts currently open in a form.
 */
export const sweepExpiredDrafts = async (
  policy: RetentionPolicy = readRetention(),
  keepScopes: string[] = [],
): Promise<SweepResult> => {
  const result: SweepResult = { archived: 0, deleted: 0, scopes: [] };
  if (policy.days <= 0 || typeof window === "undefined") return result;
  const now = Date.now();
  const entries = await listDrafts();
  for (const entry of entries) {
    if (keepScopes.includes(entry.scope)) continue;
    if (!isExpired(entry.draft, policy, now)) continue;
    if (policy.action === "archive") {
      if (await archiveDraft(entry)) {
        result.archived += 1;
        result.scopes.push(entry.scope);
      }
    } else {
      removeDraft(entry.scope);
      clearHistory(entry.scope);
      result.deleted += 1;
      result.scopes.push(entry.scope);
    }
  }
  return result;
};

export const describeSweep = (r: SweepResult): string => {
  if (r.archived === 0 && r.deleted === 0) return "";
  const parts: string[] = [];
  if (r.archived > 0) parts.push(`${r.archived} draft${r.archived === 1 ? "" : "s"} archived`);
  if (r.deleted > 0) parts.push(`${r.deleted} draft${r.deleted === 1 ? "" : "s"} deleted`);
  return `${parts.join(" and ")} after the expiration window.`;
};
