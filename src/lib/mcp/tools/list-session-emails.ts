import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { clampLimit, limitInput, sessionEmailRow } from "../schema";

export default defineTool({
  name: "list_session_emails",
  title: "List session notification emails",
  description:
    "List the notification email delivery log for vocal sessions, including subject, recipient and outcome. Staff access only.",
  inputSchema: {
    outcome: z
      .enum(["sent", "failed", "pending"])
      .optional()
      .describe("Only return emails with this delivery outcome. Omit for all outcomes."),
    limit: limitInput,
  },
  outputSchema: {
    emails: z.array(sessionEmailRow).describe("Matching email log entries, newest first."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ outcome, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let query = supabase
      .from("session_email_log")
      .select("id, request_id, kind, recipient, subject, outcome, reason, created_at")
      .order("created_at", { ascending: false })
      .limit(clampLimit(limit));
    if (outcome) query = query.eq("outcome", outcome);

    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { emails: data ?? [] },
    };
  },
});
