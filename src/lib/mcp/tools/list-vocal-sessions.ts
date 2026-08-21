import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { clampLimit, limitInput, vocalSessionRow } from "../schema";

export default defineTool({
  name: "list_vocal_sessions",
  title: "List vocal sessions",
  description:
    "List vocal session booking requests (artist, email, timezone, status, confirmed slot). Staff access only.",
  inputSchema: {
    status: z
      .enum(["requested", "confirmed", "rescheduled", "declined", "cancelled"])
      .optional()
      .describe("Only return bookings in this status. Omit to return every status."),
    limit: limitInput,
  },
  outputSchema: {
    sessions: z.array(vocalSessionRow).describe("Matching vocal session bookings, newest first."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ status, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let query = supabase
      .from("vocal_session_requests")
      .select(
        "id, artist, email, timezone, package_label, status, confirmed_slot, meeting_link, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(clampLimit(limit));
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { sessions: data ?? [] },
    };
  },
});
