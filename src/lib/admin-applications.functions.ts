import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { TRACK_STATUS_STEPS, type TrackStatusKey } from "@/lib/track-requests.functions";

const STATUS_KEYS = TRACK_STATUS_STEPS.map((s) => s.key) as [TrackStatusKey, ...TrackStatusKey[]];

const listSchema = z.object({
  status: z.enum(["all", ...STATUS_KEYS]).default("all"),
  search: z.string().trim().max(200).default(""),
  limit: z.number().int().min(1).max(200).default(100),
});

const updateSchema = z.object({
  reference: z.string().trim().min(4).max(40),
  status: z.enum(STATUS_KEYS),
  statusNote: z.string().trim().max(2000).optional().nullable(),
});

export type AdminApplication = {
  reference: string;
  artist: string;
  email: string;
  packageLabel: string;
  fileName: string | null;
  link: string | null;
  notes: string | null;
  acknowledged: boolean;
  status: TrackStatusKey;
  statusNote: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Only label staff/admins may read artist submissions (they contain emails).
 *
 * Reads the caller's own rows from `user_roles` through their RLS-scoped
 * client — the role check runs on the server against the database, never on
 * anything the browser can assert.
 */
async function assertStaff(
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, value: string) => {
          in: (col: string, values: string[]) => Promise<{ data: unknown[] | null }>;
        };
      };
    };
  },
  userId: string,
) {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "staff"]);
  if (!data || data.length === 0) throw new Error("Forbidden");
}


export const listApplications = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => listSchema.parse(data ?? {}))
  .handler(async ({ data, context }): Promise<{ applications: AdminApplication[] }> => {
    await assertStaff(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let query = supabaseAdmin
      .from("track_requests")
      .select(
        "reference_code, artist, email, package_label, file_name, link, notes, acknowledged, status, status_note, created_at, updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);

    if (data.status !== "all") query = query.eq("status", data.status);
    if (data.search) {
      const term = data.search.replace(/[%,]/g, " ");
      query = query.or(
        `artist.ilike.%${term}%,email.ilike.%${term}%,reference_code.ilike.%${term}%,package_label.ilike.%${term}%`,
      );
    }

    const { data: rows, error } = await query;
    if (error) {
      console.error("Admin application list failed:", error.message);
      throw new Error("Couldn't load applications. Try again shortly.");
    }

    return {
      applications: (rows ?? []).map((row) => ({
        reference: row.reference_code,
        artist: row.artist,
        email: row.email,
        packageLabel: row.package_label,
        fileName: row.file_name,
        link: row.link,
        notes: row.notes,
        acknowledged: row.acknowledged,
        status: row.status as TrackStatusKey,
        statusNote: row.status_note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  });

export const updateApplicationStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updateSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin
      .from("track_requests")
      .update({
        status: data.status,
        status_note: data.statusNote ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("reference_code", data.reference.trim().toUpperCase());

    if (error) {
      console.error("Admin status update failed:", error.message);
      throw new Error("Couldn't save that status change.");
    }
    return { ok: true as const };
  });
