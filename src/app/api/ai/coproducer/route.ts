const WAVESPEED_CHAT_URL = "https://api.wavespeed.ai/v1/chat/completions";

type AiAction = "enhance_style" | "optimize_lyrics" | "generate_lyrics";

type ChatPayload = {
  error?: { message?: string };
  choices?: Array<{ message?: { content?: string } }>;
};

function promptsFor(
  action: string,
  text: string,
  title: string,
  genre: string,
): { systemPrompt: string; userPrompt: string } | null {
  if (action === "enhance_style") {
    return {
      systemPrompt:
        "Expand the user's note into one Mureka music-generation prompt under 800 characters. Keep the genre, tempo, instruments, and mood. Return only the prompt.",
      userPrompt: text,
    };
  }
  if (action === "optimize_lyrics") {
    return {
      systemPrompt:
        "Format the lyrics into this section order: [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], [Outro]. Keep the original story. Return only the lyrics.",
      userPrompt: text,
    };
  }
  if (action === "generate_lyrics") {
    const vibe = genre.trim() || text.trim() || "Acoustic grunge rock";
    const heading = title.trim() || "Untitled";
    return {
      systemPrompt:
        "Write a full lyric sheet with [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], and [Outro]. Return only the lyrics.",
      userPrompt: `Title: ${heading}\nVibe: ${vibe}`,
    };
  }
  return null;
}

function isAiAction(action: string): action is AiAction {
  return action === "enhance_style" || action === "optimize_lyrics" || action === "generate_lyrics";
}

/**
 * POST /api/ai/coproducer
 * Body: { action, text, title, genre }
 * WaveSpeed chat completions. Model defaults to gemini-3.5-flash.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return Response.json({ error: "WAVESPEED_API_KEY is missing." }, { status: 500 });
    }

    const body = (await req.json()) as {
      action?: unknown;
      text?: unknown;
      title?: unknown;
      genre?: unknown;
    };
    const action = typeof body.action === "string" ? body.action : "";
    const text = typeof body.text === "string" ? body.text : "";
    const title = typeof body.title === "string" ? body.title : "";
    const genre = typeof body.genre === "string" ? body.genre : "";
    const prompts = isAiAction(action) ? promptsFor(action, text, title, genre) : null;
    if (!prompts) {
      return Response.json({ error: "Unknown AI action" }, { status: 400 });
    }

    const { systemPrompt, userPrompt } = prompts;
    const model = process.env.WAVESPEED_LLM_MODEL?.trim() || "gemini-3.5-flash";

    const res = await fetch(WAVESPEED_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    const raw = await res.text();
    let data: ChatPayload = {};
    if (raw) {
      try {
        data = JSON.parse(raw) as ChatPayload;
      } catch {
        data = {};
      }
    }

    if (!res.ok) {
      return Response.json(
        { error: data.error?.message || "WaveSpeed LLM call failed" },
        { status: res.status },
      );
    }

    const result = (data.choices?.[0]?.message?.content ?? "").trim();
    return Response.json({ success: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "WaveSpeed LLM call failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
