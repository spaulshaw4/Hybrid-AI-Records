import { createFileRoute } from "@tanstack/react-router";

/**
 * Records a support-triage row for an error the visitor actually saw:
 * the reference ID shown on screen, the redacted route context, and whether
 * they went on to open the prefilled support email.
 *
 * Public by necessity (a crashed page has no session), so the payload is
 * size-capped, shape-validated, never trusted beyond logging, and never
 * readable by anyone but admins/staff.
 */

const MAX_BODY_BYTES = 8_000;

type SupportReportPayload = {
  reference?: string;
  routeId?: string;
  pathname?: string;
  url?: string;
  stage?: string;
  params?: unknown;
  search?: unknown;
  message?: string;
  source?: string;
  emailStatus?: string;
};

const EMAIL_STATUSES = new Set(["not_sent", "opened", "sent", "failed"]);

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, max);
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, 10)
    .map((item) => item.slice(0, 120));
}

export const Route = createFileRoute("/api/public/support-reports")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) {
          return new Response("Payload too large", { status: 413 });
        }

        let payload: SupportReportPayload;
        try {
          payload = JSON.parse(raw) as SupportReportPayload;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
        if (!payload || typeof payload !== "object") {
          return new Response("Invalid payload", { status: 400 });
        }

        const reference = clean(payload.reference, 64);
        if (!reference) {
          return new Response("Missing reference", { status: 400 });
        }

        const emailStatusRaw = clean(payload.emailStatus, 20) ?? "not_sent";
        const emailStatus = EMAIL_STATUSES.has(emailStatusRaw) ? emailStatusRaw : "not_sent";
        const stageRaw = clean(payload.stage, 20) ?? "render";
        const stage = stageRaw === "loader" ? "loader" : "render";

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: existing } = await supabaseAdmin
          .from("support_error_reports")
          .select("id, occurrences, email_status")
          .eq("reference", reference)
          .maybeSingle();

        const emailOpened = emailStatus !== "not_sent";

        if (existing) {
          const { error } = await supabaseAdmin
            .from("support_error_reports")
            .update({
              occurrences: (existing.occurrences ?? 1) + 1,
              ...(emailOpened
                ? { email_status: emailStatus, email_opened_at: new Date().toISOString() }
                : {}),
            })
            .eq("id", existing.id);
          if (error) {
            console.error("[support-report] update failed", error.message);
            return new Response("Could not record report", { status: 500 });
          }
          return Response.json({ ok: true, reference, recorded: "updated" });
        }

        const { error } = await supabaseAdmin.from("support_error_reports").insert({
          reference,
          route_id: clean(payload.routeId, 200) ?? "",
          pathname: clean(payload.pathname, 300) ?? "",
          url: clean(payload.url, 500) ?? null,
          stage,
          params: cleanList(payload.params),
          search: cleanList(payload.search),
          message: clean(payload.message, 500) ?? null,
          source: clean(payload.source, 60) ?? "error-boundary",
          user_agent: clean(request.headers.get("user-agent") ?? undefined, 200) ?? null,
          email_status: emailStatus,
          email_opened_at: emailOpened ? new Date().toISOString() : null,
        });

        if (error) {
          console.error("[support-report] insert failed", error.message);
          return new Response("Could not record report", { status: 500 });
        }

        return Response.json({ ok: true, reference, recorded: "created" });
      },
    },
  },
});
