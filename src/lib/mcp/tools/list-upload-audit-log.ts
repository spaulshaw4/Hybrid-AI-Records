import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { clampLimit, limitInput, uploadAuditRow } from "../schema";

export default defineTool({
  name: "list_upload_audit_log",
  title: "List upload audit log",
  description:
    "List artist file upload, replace and delete actions with order reference and outcome. Staff access only.",
  inputSchema: {
    action: z
      .enum(["upload", "replace", "delete"])
      .optional()
      .describe("Only return entries for this action. Omit for all actions."),
    outcome: z
      .enum(["success", "failed"])
      .optional()
      .describe("Only return entries with this outcome. Omit for all outcomes."),
    limit: limitInput,
  },
  outputSchema: {
    entries: z.array(uploadAuditRow).describe("Matching audit log entries, newest first."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ action, outcome, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let query = supabase
      .from("upload_audit_log")
      .select(
        "id, action, bucket, object_path, file_name, file_size, reference_code, outcome, error_message, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(clampLimit(limit));
    if (action) query = query.eq("action", action);
    if (outcome) query = query.eq("outcome", outcome);

    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { entries: data ?? [] },
    };
  },
});
