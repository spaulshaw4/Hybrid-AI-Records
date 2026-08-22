import { writeLyricsWithStudio } from "@/lib/coproducer";

/**
 * Co-Producer lyrics: Google Interactions API via GEMINI_API_KEY.
 * Never routes through Replicate.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { trackTitle?: string; language?: string };
    const result = await writeLyricsWithStudio(
      String(body.trackTitle ?? "Untitled Track"),
      String(body.language || "English"),
    );
    return Response.json({ lyrics: result.lyrics });
  } catch (error) {
    console.error("[STUDIO_INTERACTIONS_ERROR]", error);
    const message = error instanceof Error ? error.message : "Failed to generate lyrics";
    return Response.json({ error: message }, { status: 500 });
  }
}
