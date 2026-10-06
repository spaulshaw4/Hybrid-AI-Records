const WAVESPEED_CHAT_URL = "https://api.wavespeed.ai/v1/chat/completions";

type ChatPayload = {
  error?: { message?: string };
  message?: string;
  choices?: Array<{ message?: { content?: string } }>;
};

const ENHANCE_STYLE_SYSTEM =
  "Expand the user's note into one Mureka music-generation prompt under 800 characters. Keep the genre, tempo, instruments, and mood. Return only the prompt.";

/**
 * POST /api/ai/coproducer
 * Lyric workshop actions plus style enhance variants. Model defaults to gemini-2.5-flash.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return Response.json({ error: "WAVESPEED_API_KEY is missing." }, { status: 500 });
    }

    const body = (await req.json()) as {
      action?: unknown;
      lyrics?: unknown;
      title?: unknown;
      prompt?: unknown;
      topic?: unknown;
      text?: unknown;
      genre?: unknown;
    };
    const action = typeof body.action === "string" ? body.action : "";
    const lyrics = typeof body.lyrics === "string" ? body.lyrics : "";
    const title = typeof body.title === "string" ? body.title : "";
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const topic = typeof body.topic === "string" ? body.topic : "";
    const text = typeof body.text === "string" ? body.text : "";

    let systemPrompt = "";
    let userPrompt = "";
    let temperature = 0.7;
    let maxTokens = 1500;
    switch (action) {
      case "optimize":
        systemPrompt =
          "You are an elite lyricist and vocal arranger. Optimize these lyrics to improve musical meter, natural syllable stress, and rhyme schemes while keeping the original meaning and structure intact. Return only the raw lyrics with structural tags ([Verse], [Chorus], etc.).";
        userPrompt = `Title: "${title || "Untitled"}"\n\nCurrent Lyrics:\n${lyrics}`;
        break;
      case "section":
        systemPrompt =
          "You are a music producer. Analyze these lyrics and insert proper structural tags where appropriate ([Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro]). Do not change the wording; only add or clean up the section markers.";
        userPrompt = lyrics;
        break;
      case "next_line":
        systemPrompt =
          "You are an expert songwriter. Read the lyrics and write the immediate next 2 to 4 lines that naturally follow in tone, meter, rhyme, and emotional progression. Return only the new lines to append.";
        userPrompt = `Song Title: "${title || "Untitled"}"\nExisting lines:\n${lyrics}`;
        break;
      case "generate_topic":
        systemPrompt =
          "You are an elite songwriter. Write a complete, evocative song lyric sheet with [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], and [Outro]. Return only the formatted lyrics.";
        userPrompt = `Song Title: "${title || "Untitled"}"\nStyle: "${prompt || "Heavy acoustic grunge rock"}"\nTheme or Story: "${topic || "Deep emotional narrative"}"`;
        break;
      case "enhance_style":
        systemPrompt = ENHANCE_STYLE_SYSTEM;
        userPrompt = text;
        break;
      case "enhance_match_vibe":
        temperature = 0.6;
        maxTokens = 1000;
        systemPrompt =
          "You are an elite studio producer prompt engineer for Mureka v9.5. Take the user's style idea and polish/expand it into a dense, production-grade prompt under 800 characters. Preserve their exact genre, tempo, and vibe. Explicitly define rhythm section instruments, acoustic vs electric balance, drum dynamics, and vocal timbre. Return only the prompt.";
        userPrompt = `Polish and expand this style: "${text || "Heavy acoustic grunge rock"}"`;
        break;
      case "enhance_surprise_me":
        temperature = 0.9;
        maxTokens = 1000;
        systemPrompt =
          "You are an avant-garde record producer for Mureka v9.5. Take the user's style concept and introduce a fresh, unexpected twist or genre fusion under 800 characters. Inject distinctive textures (e.g., brooding cello, swampy resonator slide, retro tape warmth, dramatic halftime drops) while maintaining high-energy musicality. Return only the prompt.";
        userPrompt = `Give this style an unexpected twist: "${text || "Acoustic rock"}"`;
        break;
      case "optimize_lyrics":
        temperature = 0.6;
        maxTokens = 1000;
        systemPrompt =
          "You are an elite lyricist. Refine these lyrics to tighten meter, cadence, and structure tags ([Verse], [Chorus], [Bridge], [Outro]). Return only the lyrics.";
        userPrompt = `Optimize these lyrics:\n\n${text}`;
        break;
      case "generate_lyrics":
        temperature = 0.6;
        maxTokens = 1000;
        systemPrompt =
          "You are an elite lyricist. Write a complete song lyric sheet with [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], and [Outro]. Return only the lyrics.";
        userPrompt = `Write complete song lyrics titled "${title || "Untitled"}" in this style: "${text || "Heavy acoustic rock"}"`;
        break;
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }

    const modelName = process.env.WAVESPEED_LLM_MODEL?.trim() || "gemini-2.5-flash";
    const res = await fetch(WAVESPEED_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
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

    if (!res.ok || data.error) {
      return Response.json(
        {
          error: `WaveSpeed LLM Error: ${data.error?.message || data.message || "WaveSpeed LLM request rejected."}`,
        },
        { status: res.status || 500 },
      );
    }

    const result = (data.choices?.[0]?.message?.content ?? "").trim();
    return Response.json({ success: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "WaveSpeed LLM call failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
