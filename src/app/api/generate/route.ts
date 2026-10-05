import { formatMurekaLyrics, formatMurekaPrompt } from "@/lib/mureka-format";

const GENERATE_SONG_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song";
const GENERATE_BGM_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-bgm";

/** Harmless on Bun. Next.js route segment config when this file is used as a route. */
export const maxDuration = 360;

const POLL_INTERVAL_MS = 3000;
const maxAttempts = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GenerateBody = {
  prompt?: unknown;
  lyrics?: unknown;
  gender?: unknown;
  isInstrumental?: unknown;
};

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as GenerateBody;
    const prompt = formatMurekaPrompt(typeof body.prompt === "string" ? body.prompt : "");
    const lyrics = formatMurekaLyrics(typeof body.lyrics === "string" ? body.lyrics : "");
    const gender = typeof body.gender === "string" && body.gender.trim() ? body.gender.trim() : "male";
    const isInstrumental = body.isInstrumental === true;

    const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return Response.json({ error: "Missing WaveSpeed API key" }, { status: 500 });
    }

    const endpoint = isInstrumental ? GENERATE_BGM_URL : GENERATE_SONG_URL;
    const payload: {
      prompt: string;
      output_format: "wav";
      lyrics?: string;
      gender?: string;
    } = {
      prompt,
      output_format: "wav",
    };
    if (!isInstrumental) {
      payload.lyrics = lyrics;
      payload.gender = gender;
    }

    const submitRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const submitData = (await submitRes.json()) as { data?: { id?: string } };
    const taskId = submitData.data?.id;
    if (!taskId) {
      return Response.json({ error: "Task submission rejected by upstream" }, { status: 500 });
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      const pollRes = await fetch(
        `https://api.wavespeed.ai/api/v3/predictions/${encodeURIComponent(taskId)}/result`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!pollRes.ok) continue;

      const pollData = (await pollRes.json()) as {
        data?: { status?: string; outputs?: unknown[] };
      };
      const status = pollData.data?.status;
      if (status === "completed") {
        return Response.json({
          success: true,
          audioUrl: pollData.data?.outputs?.[0],
        });
      }
      if (status === "failed" || status === "cancelled") {
        return Response.json({ error: "Generation failed upstream" }, { status: 500 });
      }
    }

    return Response.json({ error: "Task hit the 6-minute engine ceiling" }, { status: 504 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    return Response.json({ error: message || "Internal server error" }, { status: 500 });
  }
}
