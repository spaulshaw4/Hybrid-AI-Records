import Replicate from "replicate";

/**
 * Co-Producer lyrics endpoint. The TanStack Start server entry intercepts
 * POST /api/coproducer and calls this handler (this app is not Next.js, so
 * `next/server` is not used — Response.json is the same JSON contract).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) {
      return Response.json({ error: "Missing REPLICATE_API_TOKEN in .env" }, { status: 500 });
    }

    const { trackTitle, language, style } = await req.json();
    const replicate = new Replicate({ auth: token });
    const prompt =
      `You are an elite music co-producer. Write structured song lyrics in ${language || "English"} ` +
      `with section markers ([Verse 1], [Chorus], [Verse 2], [Bridge], [Outro]) for a song titled "${trackTitle}". ` +
      `Style: ${style || "Rock/Alternative"}.`;

    const output = await replicate.run("google/gemini-3-flash", {
      input: { prompt },
    });
    const lyrics = Array.isArray(output) ? output.join("") : String(output);
    return Response.json({ lyrics });
  } catch (error) {
    console.error("[REPLICATE_COPRODUCER_ERROR]", error);
    const message = error instanceof Error ? error.message : "Failed to generate lyrics";
    return Response.json({ error: message }, { status: 500 });
  }
}
