import {
  isLyricEngineTimeout,
  LYRIC_ENGINE_TIMEOUT_MESSAGE,
  writeLyricsWithStudio,
} from "@/lib/coproducer";

/**
 * Co-Producer lyrics: google/gemini-2.5-flash on Replicate via
 * LYRIC_ENGINE_API_KEY (alias: ENGINE_API_KEY).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { trackTitle?: string; language?: string };
    const result = await writeLyricsWithStudio(
      String(body.trackTitle ?? "Untitled Track"),
      String(body.language || "English"),
    );
    return Response.json({ lyrics: result.lyrics ?? "" });
  } catch (error) {
    console.error("[LYRIC_ENGINE_ERROR]", error);
    if (isLyricEngineTimeout(error)) {
      return Response.json({ error: LYRIC_ENGINE_TIMEOUT_MESSAGE }, { status: 504 });
    }
    const message =
      error instanceof Error ? error.message : "The Co-Producer could not write lyrics. Please try again.";
    return Response.json({ error: message }, { status: 500 });
  }
}
