import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEV_TEST_USER_UUID, isDevAuthBypass } from "@/lib/dev-auth";

const httpsUrl = z
  .string()
  .trim()
  .min(8)
  .max(2000)
  .refine((value) => /^https:\/\//i.test(value), { message: "Must be an https URL" });

const startSchema = z.object({ sampleUrl: httpsUrl });
const taskSchema = z.object({ id: z.string().trim().min(1).max(200) });
const saveSchema = z.object({
  label: z.string().trim().min(1).max(80),
  voiceId: z.string().trim().min(1).max(200),
  sampleUrl: httpsUrl,
  /** Analysis captured before upload, stored so clips can be sorted/filtered. */
  quality: z
    .object({
      peak: z.number().min(0).max(4),
      rms: z.number().min(0).max(4),
      clipRatio: z.number().min(0).max(1),
      silenceRatio: z.number().min(0).max(1),
      clipBars: z.number().int().min(0).max(100000),
      silenceBars: z.number().int().min(0).max(100000),
      totalBars: z.number().int().min(0).max(100000),
      blocked: z.boolean(),
      trimStartSeconds: z.number().min(0).max(100000),
    })
    .nullish(),
});
const deleteSchema = z.object({ id: z.string().uuid() });
const renameSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(80),
});

/** Pulls the storage object path out of a signed voice-samples URL. */
function samplePathFromUrl(url: string): string | null {
  const match = /\/voice-samples\/([^?]+)/.exec(url);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export type VoiceProfile = {
  id: string;
  label: string;
  voice_id: string;
  sample_url: string;
  created_at: string;
  peak: number | null;
  rms: number | null;
  clip_ratio: number | null;
  silence_ratio: number | null;
  clip_bars: number | null;
  silence_bars: number | null;
  total_bars: number | null;
  quality_blocked: boolean | null;
  trim_start_seconds: number | null;
};

const PROFILE_COLUMNS =
  "id,label,voice_id,sample_url,created_at,peak,rms,clip_ratio,silence_ratio,clip_bars,silence_bars,total_bars,quality_blocked,trim_start_seconds";

type PostgrestLikeError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
} | null;

/**
 * Prefer service-role for voice_profiles writes after JWT auth so RLS / stale
 * PostgREST JWT claims cannot silently zero-row the insert. Still scopes every
 * query to the authenticated `userId`.
 */
async function voiceProfilesClient() {
  const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  return requireSupabaseAdmin();
}

function voiceProfilesErrorMessage(
  action: "save" | "list" | "rename" | "delete",
  error: PostgrestLikeError,
): string {
  const message = error?.message ?? "";
  const code = error?.code ?? "";
  if (/schema cache|Could not find the table|does not exist/i.test(message) || code === "PGRST205") {
    return "Voice library table is missing. Apply supabase/migrations/20260824140000_ensure_voice_profiles.sql in the Supabase SQL Editor, then try again.";
  }
  if (code === "23503" || /foreign key|auth\.users/i.test(message)) {
    if (isDevAuthBypass()) {
      return "Dev test user is not in auth.users — save the voice locally, or sign in with a real account to sync the cloud library.";
    }
    return "Could not save that voice: your account is not linked to Auth. Sign out and sign in again.";
  }
  if (code === "42501" || /row-level security|RLS/i.test(message)) {
    return "Could not save that voice (database policy blocked the write). Re-apply the voice_profiles RLS policy, then try again.";
  }
  if (message) {
    const verb =
      action === "save"
        ? "save that voice to your library"
        : action === "rename"
          ? "rename that voice"
          : action === "delete"
            ? "remove that voice"
            : "load your voice library";
    return `Could not ${verb}: ${message}`;
  }
  return action === "save"
    ? "Could not save that voice to your library."
    : `Could not ${action} that voice.`;
}

export const startVoiceCloneJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => startSchema.parse(data))
  .handler(async ({ data }) => {
    const { startInstantVoiceClone } = await import("@/lib/instant-voice");
    void data.sampleUrl;
    return startInstantVoiceClone();
  });

export const getVoiceCloneJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => taskSchema.parse(data))
  .handler(async ({ data }) => {
    const { fetchMinimaxVoiceClone } = await import("@/lib/minimax-voice.server");
    return fetchMinimaxVoiceClone(data.id);
  });

export const listVoiceProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<VoiceProfile[]> => {
    const supabase = await voiceProfilesClient().catch(() => context.supabase);
    const { data, error } = await supabase
      .from("voice_profiles")
      .select(PROFILE_COLUMNS)
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) {
      console.warn("[voice_profiles] list failed", error.message, error.code);
      // Missing table / empty library should not hard-break the recorder UI.
      if (/schema cache|Could not find the table|does not exist/i.test(error.message)) {
        return [];
      }
      throw new Error(voiceProfilesErrorMessage("list", error));
    }
    return (data ?? []) as VoiceProfile[];
  });

export const saveVoiceProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveSchema.parse(data))
  .handler(async ({ data, context }): Promise<VoiceProfile> => {
    const userId = context.userId?.trim();
    if (!userId) {
      throw new Error("Sign in before saving a voice to your library.");
    }

    // Fake local-dev UUID is not in auth.users — fail clearly instead of FK 23503.
    if (userId === DEV_TEST_USER_UUID) {
      throw new Error(
        "Dev test user cannot write voice_profiles (no auth.users row). Use a signed-in account, or keep the take on this device only.",
      );
    }

    const supabase = await voiceProfilesClient().catch(() => context.supabase);
    const { data: row, error } = await supabase
      .from("voice_profiles")
      .insert({
        user_id: userId,
        label: data.label,
        voice_id: data.voiceId,
        sample_url: data.sampleUrl,
        peak: data.quality?.peak ?? null,
        rms: data.quality?.rms ?? null,
        clip_ratio: data.quality?.clipRatio ?? null,
        silence_ratio: data.quality?.silenceRatio ?? null,
        clip_bars: data.quality?.clipBars ?? null,
        silence_bars: data.quality?.silenceBars ?? null,
        total_bars: data.quality?.totalBars ?? null,
        quality_blocked: data.quality?.blocked ?? null,
        trim_start_seconds: data.quality?.trimStartSeconds ?? null,
      })
      .select(PROFILE_COLUMNS)
      .maybeSingle();

    if (error || !row) {
      console.error("[voice_profiles] insert failed", {
        userId,
        code: error?.code,
        message: error?.message,
        details: error?.details,
        hint: error?.hint,
      });
      throw new Error(voiceProfilesErrorMessage("save", error));
    }
    return row as VoiceProfile;
  });

export const renameVoiceProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => renameSchema.parse(data))
  .handler(async ({ data, context }): Promise<VoiceProfile> => {
    const supabase = await voiceProfilesClient().catch(() => context.supabase);
    const { data: row, error } = await supabase
      .from("voice_profiles")
      .update({ label: data.label })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select(PROFILE_COLUMNS)
      .maybeSingle();
    if (error || !row) throw new Error(voiceProfilesErrorMessage("rename", error));
    return row as VoiceProfile;
  });

export const deleteVoiceProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => deleteSchema.parse(data))
  .handler(async ({ data, context }) => {
    const supabase = await voiceProfilesClient().catch(() => context.supabase);
    // Read the row first so we can clean up the stored sample too.
    const { data: row } = await supabase
      .from("voice_profiles")
      .select("sample_url")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();

    const { error } = await supabase
      .from("voice_profiles")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(voiceProfilesErrorMessage("delete", error));

    let sampleRemoved = false;
    const path = row?.sample_url ? samplePathFromUrl(row.sample_url) : null;
    if (path) {
      const { error: storageError } = await supabase.storage.from("voice-samples").remove([path]);
      sampleRemoved = !storageError;
    }

    return { ok: true, sampleRemoved };
  });
