import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type SessionEmailEntry = {
  id: string;
  kind: string;
  recipient: string;
  subject: string;
  outcome: string;
  reason: string | null;
  slot: { date?: string; time?: string } | null;
  createdAt: string;
};

export type SessionInboxRow = {
  id: string;
  artist: string;
  email: string;
  timezone: string;
  packageLabel: string | null;
  status: string;
  meetingLink: string | null;
  confirmedSlot: { date?: string; time?: string } | null;
  createdAt: string;
  updatedAt: string;
  emails: SessionEmailEntry[];
};

const listInput = z.object({
  search: z.string().trim().max(120).optional().default(""),
  status: z
    .enum(["all", "requested", "confirmed", "rescheduled", "declined", "cancelled"])
    .optional()
    .default("all"),
  /** Email delivery outcome: pending = no notification emails logged yet. */
  emailStatus: z.enum(["all", "sent", "failed", "pending"]).optional().default("all"),
  /** Notification type (session_email_log.kind), or "all". */
  emailKind: z.string().trim().max(64).optional().default("all"),
  /** Inclusive date range (YYYY-MM-DD) applied to the session request date. */
  from: z.string().trim().max(32).optional().default(""),
  to: z.string().trim().max(32).optional().default(""),
  limit: z.number().int().min(1).max(200).optional().default(100),
});


/** Staff-only: every scheduled session with its full email delivery history. */
export const listSessionInbox = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => listInput.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "staff"]);
    if (!roles || roles.length === 0) throw new Error("Forbidden");

    let query = context.supabase
      .from("vocal_session_requests")
      .select(
        "id, artist, email, timezone, package_label, status, meeting_link, confirmed_slot, created_at, updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);

    if (data.status !== "all") query = query.eq("status", data.status);
    if (data.search) {
      const term = `%${data.search}%`;
      query = query.or(`artist.ilike.${term},email.ilike.${term}`);
    }
    if (data.from) query = query.gte("created_at", `${data.from}T00:00:00.000Z`);
    if (data.to) query = query.lte("created_at", `${data.to}T23:59:59.999Z`);


    const { data: sessions, error } = await query;
    if (error) throw new Error(error.message);

    const ids = (sessions ?? []).map((s) => s.id);
    const logsByRequest = new Map<string, SessionEmailEntry[]>();

    if (ids.length > 0) {
      const { data: logs, error: logError } = await context.supabase
        .from("session_email_log")
        .select("id, request_id, kind, recipient, subject, outcome, reason, slot, created_at")
        .in("request_id", ids)
        .order("created_at", { ascending: false });
      if (logError) throw new Error(logError.message);

      for (const row of logs ?? []) {
        const list = logsByRequest.get(row.request_id) ?? [];
        list.push({
          id: row.id,
          kind: row.kind,
          recipient: row.recipient,
          subject: row.subject,
          outcome: row.outcome,
          reason: row.reason,
          slot: (row.slot ?? null) as SessionEmailEntry["slot"],
          createdAt: row.created_at,
        });
        logsByRequest.set(row.request_id, list);
      }
    }

    const allRows: SessionInboxRow[] = (sessions ?? []).map((s) => ({
      id: s.id,
      artist: s.artist,
      email: s.email,
      timezone: s.timezone,
      packageLabel: s.package_label,
      status: s.status,
      meetingLink: s.meeting_link,
      confirmedSlot: (s.confirmed_slot ?? null) as SessionInboxRow["confirmedSlot"],
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      emails: logsByRequest.get(s.id) ?? [],
    }));

    const availableKinds = Array.from(
      new Set(allRows.flatMap((r) => r.emails.map((e) => e.kind))),
    ).sort();

    const matchesKind = (kind: string) => data.emailKind === "all" || kind === data.emailKind;
    const rows = allRows.filter((row) => {
      const scoped = row.emails.filter((e) => matchesKind(e.kind));
      if (data.emailStatus === "pending") return scoped.length === 0;
      if (data.emailStatus === "sent") return scoped.some((e) => e.outcome === "sent");
      if (data.emailStatus === "failed") return scoped.some((e) => e.outcome !== "sent");
      return data.emailKind === "all" || scoped.length > 0;
    });

    return { rows, availableKinds };

  });
