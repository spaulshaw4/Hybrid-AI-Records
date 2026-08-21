/**
 * Optional account-based cloud sync for in-progress application drafts.
 *
 * Local autosave (see application-drafts.ts) always runs. When the artist is
 * signed in AND has opted in, each draft is also mirrored to
 * `public.application_drafts`, which is RLS-scoped to `auth.uid()` so drafts
 * follow the account across devices and nobody else can read them.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  hasDraftContent,
  writeDraft,
  readDraft,
  type ApplicationDraft,
  type SavedDraftEntry,
} from "@/lib/application-drafts";

const OPT_IN_KEY = "hybrid.application.cloudsync.v1";

export const isCloudSyncEnabled = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(OPT_IN_KEY) === "on";
  } catch {
    return false;
  }
};

export const setCloudSyncEnabled = (on: boolean) => {
  try {
    window.localStorage.setItem(OPT_IN_KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable — sync stays session-only */
  }
};

/** Signed-in user id, or null when the visitor is a guest. */
export const currentUserId = async (): Promise<string | null> => {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data.user?.id ?? null;
  } catch {
    return null;
  }
};

const toEntry = (row: {
  scope: string;
  artist: string;
  email: string;
  pkg: string;
  link: string;
  notes: string;
  ack: boolean;
  saved_at: string;
}): SavedDraftEntry => {
  const [slug = row.scope, mode = ""] = row.scope.split(":");
  return {
    scope: row.scope,
    slug,
    mode,
    draft: {
      artist: row.artist,
      email: row.email,
      pkg: row.pkg,
      link: row.link,
      notes: row.notes,
      ack: row.ack,
      savedAt: new Date(row.saved_at).getTime(),
    },
  };
};

export type SyncResult = { ok: boolean; reason?: "signed-out" | "disabled" | "error" };

/** Mirror one draft slot to the signed-in account. */
export const pushDraftToAccount = async (
  scope: string,
  draft: ApplicationDraft,
): Promise<SyncResult> => {
  if (!isCloudSyncEnabled()) return { ok: false, reason: "disabled" };
  const userId = await currentUserId();
  if (!userId) return { ok: false, reason: "signed-out" };
  if (!hasDraftContent(draft)) return { ok: true };

  const { error } = await supabase.from("application_drafts").upsert(
    {
      user_id: userId,
      scope,
      artist: draft.artist,
      email: draft.email,
      pkg: draft.pkg,
      link: draft.link,
      notes: draft.notes,
      ack: draft.ack,
      saved_at: new Date(draft.savedAt || Date.now()).toISOString(),
    },
    { onConflict: "user_id,scope" },
  );
  if (error) return { ok: false, reason: "error" };
  return { ok: true };
};

/** Every draft stored on the signed-in account, newest first. */
export const listAccountDrafts = async (): Promise<SavedDraftEntry[]> => {
  const userId = await currentUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("application_drafts")
    .select("scope, artist, email, pkg, link, notes, ack, saved_at")
    .order("saved_at", { ascending: false });
  if (error || !data) return [];
  return data.map(toEntry).filter((e) => hasDraftContent(e.draft));
};

export const deleteAccountDraft = async (scope: string): Promise<SyncResult> => {
  const userId = await currentUserId();
  if (!userId) return { ok: false, reason: "signed-out" };
  const { error } = await supabase.from("application_drafts").delete().eq("scope", scope);
  return error ? { ok: false, reason: "error" } : { ok: true };
};

/**
 * Bring the account's drafts onto this device. The newer copy of each slot
 * wins, so switching devices mid-application never loses typed answers.
 * Returns the number of local slots that were updated from the cloud.
 */
export const mergeAccountDraftsIntoDevice = async (): Promise<number> => {
  const cloud = await listAccountDrafts();
  let restored = 0;
  for (const entry of cloud) {
    const local = await readDraft(entry.scope);
    if (local && local.savedAt >= entry.draft.savedAt) continue;
    if (await writeDraft(entry.scope, entry.draft)) restored += 1;

  }
  return restored;
};

/** Push every local draft up after the artist opts in or signs in. */
export const pushDeviceDraftsToAccount = async (
  entries: SavedDraftEntry[],
): Promise<number> => {
  let pushed = 0;
  for (const entry of entries) {
    const res = await pushDraftToAccount(entry.scope, entry.draft);
    if (res.ok) pushed += 1;
  }
  return pushed;
};
