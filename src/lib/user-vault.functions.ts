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
  createdAt: string;
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
});

/** Opens a vault row the moment Generate is pressed. */
export const createUserVaultTrack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createSchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    const id = await persistUserVault(context.supabase, context.userId, {
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
  .inputValidator((data: unknown) => finishSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    await persistUserVault(context.supabase, context.userId, {
      id: data.id,
      title: data.title || "Untitled Track",
      style: data.style,
      status: data.status,
      masterUrl: data.masterUrl,
      instrumentalUrl: data.instrumentalUrl,
      vocalUrl: data.vocalUrl,
    });
    return { ok: true };
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
        createdAt: row.created_at,
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
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { deleteUserVaultApiTrack } = await import("@/lib/user-vault.server");
    const deleted = await deleteUserVaultApiTrack(context.userId, data.id);
    if (!deleted) throw new Error("Could not delete that vault track.");
    return { ok: true };
  });
