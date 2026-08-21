import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const input = z.object({ requestId: z.string().uuid() });

export type BookingStatus = {
  found: boolean;
  status: string | null;
  confirmedSlot: { date?: string; time?: string } | null;
  meetingLink: string | null;
  rescheduleRound: number;
};

/**
 * Public status lookup for one booking. Keyed by the unguessable row id the
 * artist received when they booked, and it returns no personal data — only the
 * booking's own status, confirmed slot and video-chat room.
 */
export const getVocalSessionStatus = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => input.parse(data))
  .handler(async ({ data }): Promise<BookingStatus> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // The latest row in the chain (original or any reschedule) carries the
    // current state, so a new reschedule never hides an existing confirmation.
    const { data: rows, error } = await supabaseAdmin
      .from("vocal_session_requests")
      .select("id, status, confirmed_slot, meeting_link, reschedule_round")
      .or(`id.eq.${data.requestId},original_request_id.eq.${data.requestId}`)
      .order("reschedule_round", { ascending: false })
      .limit(1);

    const row = rows?.[0];
    if (error || !row) {
      return {
        found: false,
        status: null,
        confirmedSlot: null,
        meetingLink: null,
        rescheduleRound: 0,
      };
    }

    return {
      found: true,
      status: row.status,
      confirmedSlot: (row.confirmed_slot ?? null) as BookingStatus["confirmedSlot"],
      meetingLink: row.meeting_link,
      rescheduleRound: row.reschedule_round ?? 0,
    };
  });
