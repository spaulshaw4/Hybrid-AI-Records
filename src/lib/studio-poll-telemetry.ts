/**
 * Silent client → Supabase telemetry for studio generate / vault poll hiccups.
 * Never surfaces toasts or banners — fire-and-forget into funnel_events.
 */

import { supabase } from "@/integrations/supabase/client";
import { visitorSessionId } from "@/lib/funnel-analytics";

export type StudioPollDisconnectDetails = {
  source: "vault_poll" | "sse_stream" | "status_poll" | "vault_catalog";
  message?: string;
  vaultId?: string | null;
  taskId?: string | null;
  statusCode?: number;
  /** e.g. StudioStreamDroppedError — telemetry only, never shown in UI */
  errorName?: string | null;
};

/** Best-effort insert; must never throw or block the poll loop. */
export function logTransientPollDisconnect(details: StudioPollDisconnectDetails): void {
  if (typeof window === "undefined") return;
  const reference = (details.vaultId || details.taskId || "").slice(0, 40) || null;
  const isStreamDrop =
    details.source === "sse_stream" ||
    details.errorName === "StudioStreamDroppedError" ||
    /stream.?drop/i.test(details.message ?? "");
  void supabase
    .from("funnel_events")
    .insert({
      event: "studio_poll_disconnect",
      step: "generate",
      reference,
      visitor_session: visitorSessionId(),
      details: {
        kind: isStreamDrop ? "stream_drop" : "transient_network",
        source: details.source,
        message: details.message?.slice(0, 200) ?? null,
        errorName: details.errorName?.slice(0, 80) ?? null,
        statusCode: details.statusCode ?? null,
        at: new Date().toISOString(),
      },
    })
    .then(({ error }) => {
      if (error) console.warn("[studio-telemetry] disconnect not recorded:", error.message);
    });
}
