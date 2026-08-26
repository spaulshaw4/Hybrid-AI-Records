import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { UserVaultStatus } from "@/lib/user-vault.server";

export type UserVaultRow = {
  id: string;
  title: string;
  style: string;
  status: UserVaultStatus;
  masterUrl: string;
  instrumentalUrl: string;
  vocalUrl: string;
  /** Raw Gate 1 engine audio, before stems and mastering. */
  rawAudioUrl: string;
  createdAt: string;
  artistName: string;
  albumName: string;
};

const createSchema = z.object({
  title: z.string().trim().max(160).default("Untitled Track"),
  style: z.string().trim().max(600).default(""),
});

const finishSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().max(160).optional(),
  style: z.string().trim().max(600).optional(),
  status: z.enum(["processing", "completed", "failed"]),
  masterUrl: z.string().trim().max(2000).optional(),
  instrumentalUrl: z.string().trim().max(2000).optional(),
  vocalUrl: z.string().trim().max(2000).optional(),
  tokensUsed: z.number().int().min(0).max(100).optional(),
});

const claimSchema = z.object({
  tracks: z
    .array(
      z.object({
        title: z.string().trim().max(160),
        style: z.string().trim().max(600).optional(),
        masterUrl: z.string().trim().max(2000),
        instrumentalUrl: z.string().trim().max(2000).optional().nullable(),
        vocalUrl: z.string().trim().max(2000).optional().nullable(),
        rawAudioUrl: z.string().trim().max(2000).optional().nullable(),
        tokensUsed: z.number().int().min(0).max(100).optional(),
        createdAt: z.string().trim().max(64).optional(),
      }),
    )
    .max(40),
});

/** Opens a vault row the moment Generate is pressed. */
export const createUserVaultTrack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => createSchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Prefer service role so the processing badge is visible even if the
    // request JWT cannot satisfy RLS (stale session / clock skew).
    const db = tryGetSupabaseAdmin() ?? context.supabase;
    const id = await persistUserVault(db, context.userId, {
      title: data.title || "Untitled Track",
      style: data.style,
      status: "processing",
    });
    if (!id) throw new Error("Could not open a vault record.");
    return { id };
  });

/** Flips a vault row to completed/failed and stores stem URLs. */
export const finalizeUserVaultTrack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => finishSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = tryGetSupabaseAdmin() ?? context.supabase;
    await persistUserVault(db, context.userId, {
      id: data.id,
      title: data.title || "Untitled Track",
      style: data.style,
      status: data.status,
      masterUrl: data.masterUrl,
      instrumentalUrl: data.instrumentalUrl,
      vocalUrl: data.vocalUrl,
      tokensUsed: data.tokensUsed,
    });
    return { ok: true };
  });

/**
 * Imports guest/device-local vault tracks into the signed-in artist's cloud vault.
 * Called once after login so anonymous generations are not lost.
 */
export const claimGuestVaultTracks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => claimSchema.parse(data ?? { tracks: [] }))
  .handler(async ({ data, context }) => {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = tryGetSupabaseAdmin() ?? context.supabase;
    let claimed = 0;
    for (const track of data.tracks) {
      const id = await persistUserVault(db, context.userId, {
        title: track.title,
        style: track.style,
        status: "completed",
        masterUrl: track.masterUrl,
        instrumentalUrl: track.instrumentalUrl,
        vocalUrl: track.vocalUrl,
        rawAudioUrl: track.rawAudioUrl,
        tokensUsed: track.tokensUsed ?? 1,
      });
      if (id) claimed += 1;
    }
    return { ok: true as const, claimed };
  });

/** Newest-first vault catalog. Stored files get a fresh signed URL on load. */
export const listUserVaultTracks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<UserVaultRow[]> => {
    try {
      const { listUserVaultApiTracks } = await import("@/lib/user-vault.server");
      const tracks = await listUserVaultApiTracks(context.userId);
      return tracks.map((row) => ({
        id: row.id,
        title: row.title,
        style: row.style,
        status: row.status,
        masterUrl: row.master_url ?? "",
        instrumentalUrl: row.instrumental_url ?? "",
        vocalUrl: row.vocal_url ?? "",
        rawAudioUrl: row.raw_audio_url ?? "",
        createdAt: row.created_at,
        artistName: row.artist_name,
        albumName: row.album_name,
      }));
    } catch (error) {
      console.warn(
        "[user_vault] catalog fallback empty",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  });

/** Deletes the vault row and purges master + stem files from storage. */
export const deleteUserVaultTrack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { deleteUserVaultApiTrack } = await import("@/lib/user-vault.server");
    const deleted = await deleteUserVaultApiTrack(context.userId, data.id);
    if (!deleted) throw new Error("Could not delete that vault track.");
    return { ok: true };
  });
