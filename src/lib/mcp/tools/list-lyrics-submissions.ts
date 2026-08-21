import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { clampLimit, limitInput, lyricsSubmissionRow } from "../schema";

export default defineTool({
  name: "list_lyrics_submissions",
  title: "List lyrics submissions",
  description:
    "List artist lyrics submissions with package, language and status. Staff access only.",
  inputSchema: {
    language: z
      .string()
      .min(1)
      .optional()
      .describe("Only return submissions in this language, e.g. English."),
    limit: limitInput,
  },
  outputSchema: {
    submissions: z
      .array(lyricsSubmissionRow)
      .describe("Matching lyrics submissions, newest first."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ language, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let query = supabase
      .from("lyrics_submissions")
      .select("id, artist, email, package_label, language, file_name, status, created_at")
      .order("created_at", { ascending: false })
      .limit(clampLimit(limit));
    if (language) query = query.eq("language", language);

    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { submissions: data ?? [] },
    };
  },
});
