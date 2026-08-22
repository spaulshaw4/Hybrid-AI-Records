import { writeLyrics } from "@/lib/lyrics.server";

/**
 * Co-Producer lyrics endpoint. The TanStack Start server entry intercepts
 * POST /api/coproducer and calls this handler.
 * Uses GEMINI_API_KEY with @google/genai (`gemini-2.5-flash`).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) {
      console.error("[CO_PRODUCER] GEMINI_API_KEY is undefined — add it to .env.local");
      return Response.json({ error: "Missing GEMINI_API_KEY in .env.local" }, { status: 500 });
    }

    const { trackTitle, language, style } = await req.json();
    const lyrics = await writeLyrics({
      concept: String(trackTitle ?? "Untitled"),
      title: String(trackTitle ?? "Untitled"),
      language: String(language || "English"),
      style: style ? String(style) : "Rock/Alternative",
    });
    return Response.json({ lyrics });
  } catch (error) {
    console.error("[CO_PRODUCER_API_ERROR]", error);
    const message = error instanceof Error ? error.message : "Failed to generate lyrics";
    return Response.json({ error: message }, { status: 500 });
  }
}
