import {
  injectLyricStructureAnchors,
  optimizeStylePromptViaGemini,
} from "@/lib/optimize-style-prompt.server";

/**
 * POST /api/ai/optimize-prompt
 * Body: { userText: string, lyrics?: string, bpm?: number }
 * Returns: { optimizedPrompt, lyricAnchors, lyrics? }
 *
 * Runs google/gemini-2.5-flash on Replicate (REPLICATE_API_TOKEN).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      userText?: string;
      prompt?: string;
      text?: string;
      lyrics?: string;
      bpm?: number;
    };
    const userText = String(body.userText ?? body.prompt ?? body.text ?? "").trim();
    if (userText.length < 2) {
      return Response.json(
        { error: "Add a short style concept in the Style Prompt box first." },
        { status: 400 },
      );
    }

    const withTempo =
      typeof body.bpm === "number" && Number.isFinite(body.bpm) && !/\bbpm\b/i.test(userText)
        ? `${userText}, ${Math.round(body.bpm)} BPM`
        : userText;

    const existingLyrics = typeof body.lyrics === "string" ? body.lyrics : "";
    const result = await optimizeStylePromptViaGemini(withTempo, {
      lyrics: existingLyrics,
    });
    const lyrics = injectLyricStructureAnchors(existingLyrics, result.lyricAnchors);

    console.warn("[STYLE_OPTIMIZE]", {
      inputChars: withTempo.length,
      outputChars: result.stylePrompt.length,
      anchors: result.lyricAnchors.length,
    });

    return Response.json({
      optimizedPrompt: result.stylePrompt,
      prompt: result.stylePrompt,
      lyricAnchors: result.lyricAnchors,
      lyrics,
    });
  } catch (error) {
    console.error("[STYLE_OPTIMIZE_ERROR]", error);
    const message =
      error instanceof Error
        ? error.message
        : "Style optimization failed. Check REPLICATE_API_TOKEN and try again.";
    const status = /not configured|REPLICATE_API/i.test(message) ? 503 : 500;
    return Response.json({ error: message }, { status });
  }
}
