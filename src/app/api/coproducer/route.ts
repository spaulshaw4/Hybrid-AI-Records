import { GoogleGenAI } from "@google/genai";

/**
 * Co-Producer lyrics: Google Gemini directly via GEMINI_API_KEY.
 * Never routes through Replicate.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey?.trim()) {
      console.error("[GEMINI_DIRECT_ERROR]", "GEMINI_API_KEY is undefined — add it to .env.local");
      return Response.json({ error: "Missing GEMINI_API_KEY in .env.local" }, { status: 500 });
    }

    const body = (await req.json()) as { trackTitle?: string; language?: string };
    const trackTitle = String(body.trackTitle ?? "Untitled");
    const language = String(body.language || "English");

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Write complete song lyrics with [Verse], [Chorus], [Bridge], [Outro] in ${language} for a track titled "${trackTitle}".`,
    });
    return Response.json({ lyrics: response.text });
  } catch (error) {
    console.error("[GEMINI_DIRECT_ERROR]", error);
    const message = error instanceof Error ? error.message : "Failed to generate lyrics";
    return Response.json({ error: message }, { status: 500 });
  }
}
