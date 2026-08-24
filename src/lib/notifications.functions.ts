import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type AppNotification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  reference: string | null;
  emailed: boolean;
  readAt: string | null;
  createdAt: string;
};

/** Every notification for the signed-in artist, newest first. */
export const listNotifications = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_notifications")
      .select("id, kind, title, body, reference, emailed, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    const items: AppNotification[] = (data ?? []).map((row) => ({
      id: row.id as string,
      kind: row.kind as string,
      title: row.title as string,
      body: row.body as string,
      reference: (row.reference as string | null) ?? null,
      emailed: Boolean(row.emailed),
      readAt: (row.read_at as string | null) ?? null,
      createdAt: row.created_at as string,
    }));
    return { items, unread: items.filter((i) => !i.readAt).length };
  });

/** Marks one notification, or all of them, as read. */
export const markNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ id: z.string().uuid().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const query = context.supabase
      .from("user_notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);
    const { error } = data.id ? await query.eq("id", data.id) : await query;
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Records the token-rollback notice for the signed-in artist after a failed
 * generation. The message is fixed server-side so the browser can't inject
 * arbitrary notification text.
 */
export const notifyGenerationFailed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        trackTitle: z.string().trim().max(120).optional(),
        reference: z.string().trim().max(200).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { notifyUser } = await import("./notifications.server");
    const suffix = data.trackTitle ? ` (“${data.trackTitle}”)` : "";
    await notifyUser({
      userId: context.userId,
      kind: "generation_failed",
      title: "Generation error detected",
      body: `Generation error detected. Your token remains in your balance.${suffix}`,
      reference: data.reference ?? null,
    });
    return { ok: true };
  });
