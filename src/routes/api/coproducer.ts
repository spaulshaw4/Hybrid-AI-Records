import { createFileRoute } from "@tanstack/react-router";
import Replicate from "replicate";

/**
 * Direct Co-Producer endpoint. Step 1 POSTs here with fetch("/api/coproducer")
 * so lyrics generation does not depend on TanStack server functions.
 * Uses the Replicate account balance on Google Gemini Flash.
 */
export const Route = createFileRoute("/api/coproducer")({
  server: {
    handlers: {
      POST: handleCoProducer,
    },
  },
});

const GEMINI_MODEL =
  (typeof process !== "undefined" && process.env["REPLICATE_GEMINI_MODEL"]?.trim()) ||
  "google/gemini-3-flash";

async function handleCoProducer({ request }: { request: Request }): Promise<Response> {
  try {
    const token = process.env.REPLICATE_API_TOKEN?.trim();
    if (!token) {
      return Response.json({ error: "Missing REPLICATE_API_TOKEN" }, { status: 500 });
    }

    const { trackTitle, language, style } = (await request.json()) as {
      trackTitle?: unknown;
      language?: unknown;
      style?: unknown;
    };

    const title = String(trackTitle ?? "").trim();
    if (!title) {
      return Response.json({ error: "Please enter a Track Title first." }, { status: 400 });
    }

    const replicate = new Replicate({ auth: token });
    const prompt =
      `You are an elite music co-producer and lyricist. Write complete, structured song lyrics in ${String(language || "English")} ` +
      `with section markers ([Verse 1], [Chorus], [Verse 2], [Bridge], [Outro]) for a song titled "${title}". ` +
      `Style: ${String(style || "Rock/Alternative")}.`;

    // Uses the Replicate balance on Google Gemini
    const output = await replicate.run(GEMINI_MODEL as `${string}/${string}`, {
      input: { prompt },
    });
    const lyrics = Array.isArray(output) ? output.join("") : String(output);
    return Response.json({ lyrics });
  } catch (error) {
    console.error("[REPLICATE_GEMINI_ERROR]", error);
    const message = error instanceof Error ? error.message : "Replicate prediction failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
