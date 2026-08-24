import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type StudioTrackRow = {
  id: string;
  title: string;
  audioUrl: string;
  style: string;
  prompt: string;
  status: "generating" | "ready" | "failed";
  error: string | null;
  createdAt: string;
};

const createSchema = z.object({
  title: z.string().trim().max(160).default("Untitled master track"),
  style: z.string().trim().max(600).default(""),
  prompt: z.string().trim().max(600).default(""),
});

const finishSchema = z.object({
  id: z.string().uuid(),
  audioUrl: z.string().trim().max(2000).optional(),
  title: z.string().trim().max(160).optional(),
  status: z.enum(["generating", "ready", "failed"]),
  error: z.string().trim().max(500).optional(),
});

/** Opens a vault row the moment a generation starts, so nothing is ever lost. */
export const createStudioTrack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => createSchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("studio_tracks")
      .insert({
        user_id: context.userId,
        title: data.title || "Untitled master track",
        style: data.style,
        prompt: data.prompt,
        mastered_status: "generating",
      })
      .select("id")
      .single();
    if (error || !row) throw new Error("Could not start a track record.");
    return { id: row.id as string };
  });

/** Stores the permanent audio location (or the failure) for a vault row. */
export const finalizeStudioTrack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => finishSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { storagePathFromUrl, refreshTrackAudio } = await import("./track-refresh.server");
    // Temporary third-party engine URLs never reach the database: they are
    // copied into our own bucket first, and only that path/URL is stored.
    const { isPlayableVaultAudioUrl } = await import("@/lib/vault-tracks");
    let permanentUrl: string | null = null;
    if (data.audioUrl) {
      permanentUrl = storagePathFromUrl(data.audioUrl) ? data.audioUrl : null;
      if (!permanentUrl) {
        const rescued = await refreshTrackAudio(data.audioUrl, context.userId).catch(() => null);
        if (rescued && rescued.status === "ok" && storagePathFromUrl(rescued.audioUrl)) {
          permanentUrl = rescued.audioUrl;
        }
      }
      // Local vault / temp masters are already playable same-origin URLs.
      if (!permanentUrl && isPlayableVaultAudioUrl(data.audioUrl)) {
        permanentUrl = data.audioUrl;
      }
    }
    const storagePath = permanentUrl ? storagePathFromUrl(permanentUrl) : null;
    const failedArchive = Boolean(data.audioUrl) && !permanentUrl;

    if (data.status === "failed" && !permanentUrl) {
      const { data: existing } = await context.supabase
        .from("studio_tracks")
        .select("audio_url")
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (existing?.audio_url) {
        return { ok: true, audioUrl: existing.audio_url };
      }
    }

    const { error } = await context.supabase
      .from("studio_tracks")
      .update({
        mastered_status: failedArchive ? "failed" : data.status,
        ...(permanentUrl ? { audio_url: permanentUrl } : {}),
        ...(storagePath ? { storage_path: storagePath } : {}),
        ...(data.title ? { title: data.title } : {}),
        error_message:
          data.error ?? (failedArchive ? "The finished audio could not be saved to storage." : null),
      })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error("Could not save the track record.");
    return { ok: true, audioUrl: permanentUrl };
  });


/**
 * The user's permanent track catalog, newest first. Stored files get a freshly
 * signed URL on every load, so downloads and playback never expire.
 */
export const listStudioTracks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<StudioTrackRow[]> => {
    const { data, error } = await context.supabase
      .from("studio_tracks")
      .select("id, title, audio_url, storage_path, style, prompt, mastered_status, error_message, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error("Could not load your track library.");

    const rows = data ?? [];
    const needsSigning = rows.some((row) => row.storage_path);
    let signed = new Map<string, string>();
    if (needsSigning) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { STUDIO_AUDIO_BUCKET } = await import("./track-refresh.server");
      const paths = rows.map((row) => row.storage_path).filter((p): p is string => Boolean(p));
      const { data: urls } = await supabaseAdmin.storage
        .from(STUDIO_AUDIO_BUCKET)
        .createSignedUrls(paths, 60 * 60 * 24 * 7);
      signed = new Map(
        (urls ?? [])
          .filter((entry): entry is { path: string; signedUrl: string; error: null } =>
            Boolean(entry.signedUrl && entry.path),
          )
          .map((entry) => [entry.path, entry.signedUrl] as const),
      );

    }

    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? "Untitled master track",
      audioUrl: (row.storage_path ? signed.get(row.storage_path) : null) ?? row.audio_url ?? "",
      style: row.style ?? "",
      prompt: row.prompt ?? "",
      status: (row.mastered_status as StudioTrackRow["status"]) ?? "ready",
      error: row.error_message ?? null,
      createdAt: row.created_at,
    }));
  });

/** Permanently removes one of the caller's tracks (row plus stored audio). */
export const deleteStudioTrack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("studio_tracks")
      .select("storage_path")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();

    const { error } = await context.supabase
      .from("studio_tracks")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error("Could not delete that track.");

    if (row?.storage_path) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { STUDIO_AUDIO_BUCKET } = await import("./track-refresh.server");
      await supabaseAdmin.storage.from(STUDIO_AUDIO_BUCKET).remove([row.storage_path]);
    }
    return { ok: true };
  });
