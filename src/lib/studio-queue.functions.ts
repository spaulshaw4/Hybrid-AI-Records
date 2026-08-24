import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const STUDIO_STATUSES = ["queued", "in_production", "delivered"] as const;
export type StudioStatus = (typeof STUDIO_STATUSES)[number];

export const STUDIO_BUCKET = "studio-deliveries";

export type StudioRequestRow = {
  id: string;
  reference: string;
  artist: string;
  email: string;
  title: string;
  style: string;
  brief: string;
  instrumental: boolean;
  status: StudioStatus;
  deliveryUrl: string | null;
  deliveryPath: string | null;
  deliveryNote: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

const submitSchema = z.object({
  artist: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  title: z.string().trim().max(120).default(""),
  style: z.string().trim().max(2000).default(""),
  brief: z.string().trim().min(10).max(3000),
  instrumental: z.boolean().default(false),
});

const statusSchema = z.object({
  reference: z.string().trim().min(4).max(40),
  email: z.string().trim().email().max(200),
});

const updateSchema = z.object({
  reference: z.string().trim().min(4).max(40),
  status: z.enum(STUDIO_STATUSES),
  deliveryUrl: z.string().trim().max(2000).default(""),
  deliveryPath: z.string().trim().max(500).default(""),
  deliveryNote: z.string().trim().max(2000).default(""),
});

function makeReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `HAR-${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Staff/admin gate evaluated against the caller's own roles under RLS. */
async function assertStaff(supabase: any, userId: string) {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "staff"]);
  if (!data || data.length === 0) throw new Error("Forbidden");
}

export const submitStudioRequest = createServerFn({ method: "POST" })
  .validator((data: unknown) => submitSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const reference = makeReference();

    const { error } = await supabaseAdmin.from("studio_requests").insert({
      reference,
      artist: data.artist,
      email: data.email.toLowerCase(),
      title: data.title,
      style: data.style,
      brief: data.brief,
      instrumental: data.instrumental,
      status: "queued",
    });

    if (error) throw new Error("Could not place your track in the queue. Try again in a moment.");
    return { reference };
  });

export const getStudioRequestStatus = createServerFn({ method: "POST" })
  .validator((data: unknown) => statusSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row } = await supabaseAdmin
      .from("studio_requests")
      .select("reference, artist, email, title, style, status, delivery_url, delivery_path, delivery_note, delivered_at, created_at")
      .eq("reference", data.reference.trim().toUpperCase())
      .maybeSingle();

    if (!row || row.email.toLowerCase() !== data.email.trim().toLowerCase()) {
      return { ok: false as const, message: "No session found for that reference and email." };
    }

    let audioUrl: string | null = row.delivery_url ?? null;
    if (!audioUrl && row.delivery_path) {
      const { data: signed } = await supabaseAdmin.storage
        .from(STUDIO_BUCKET)
        .createSignedUrl(row.delivery_path, 60 * 60 * 6);
      audioUrl = signed?.signedUrl ?? null;
    }

    return {
      ok: true as const,
      reference: row.reference,
      artist: row.artist,
      title: row.title as string,
      style: row.style as string,
      status: row.status as StudioStatus,
      note: (row.delivery_note as string | null) ?? null,
      deliveredAt: (row.delivered_at as string | null) ?? null,
      createdAt: row.created_at as string,
      audioUrl,
    };
  });

export const checkStudioStaff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await (context.supabase as any)
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "staff"]);
    return { staff: Boolean(data && data.length > 0) };
  });

export const listStudioRequests = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) =>
    z
      .object({ status: z.enum([...STUDIO_STATUSES, "all"]).default("all") })
      .parse(data ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ requests: StudioRequestRow[] }> => {
    await assertStaff(context.supabase as any, context.userId);

    let query = (context.supabase as any)
      .from("studio_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (data.status !== "all") query = query.eq("status", data.status);

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);

    return {
      requests: (rows ?? []).map((row: any) => ({
        id: row.id,
        reference: row.reference,
        artist: row.artist,
        email: row.email,
        title: row.title,
        style: row.style,
        brief: row.brief,
        instrumental: row.instrumental,
        status: row.status,
        deliveryUrl: row.delivery_url,
        deliveryPath: row.delivery_path,
        deliveryNote: row.delivery_note,
        deliveredAt: row.delivered_at,
        createdAt: row.created_at,
      })),
    };
  });

export const updateStudioRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => updateSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase as any, context.userId);

    const patch: Record<string, unknown> = {
      status: data.status,
      delivery_url: data.deliveryUrl || null,
      delivery_note: data.deliveryNote || null,
      delivered_at: data.status === "delivered" ? new Date().toISOString() : null,
    };
    if (data.deliveryPath) patch['delivery_path'] = data.deliveryPath;

    const { error } = await (context.supabase as any)
      .from("studio_requests")
      .update(patch)
      .eq("reference", data.reference);

    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const createStudioUploadTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) =>
    z
      .object({
        reference: z.string().trim().min(4).max(40),
        fileName: z.string().trim().min(1).max(200),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase as any, context.userId);

    const safe = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "master.mp3";
    const path = `${data.reference}/${Date.now()}-${safe}`;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: signed, error } = await supabaseAdmin.storage
      .from(STUDIO_BUCKET)
      .createSignedUploadUrl(path);

    if (error || !signed) throw new Error("Could not open an upload slot.");
    return { path: signed.path, token: signed.token };
  });
