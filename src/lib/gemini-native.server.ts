/**
 * Native Gemini generateContent helpers (server only).
 *
 * Co-Producer lyrics call Google's generateContent API directly using
 * GEMINI_API_KEY / GOOGLE_API_KEY — a cheap HTTP text model, not a Replicate GPU.
 */

import {
  aiFastModel,
  geminiGenerateContentUrl,
  geminiNativeHeaders,
} from "@/lib/ai-provider.server";
import { resilientFetch } from "@/lib/resilient-fetch.server";

type GeminiBody = {
  systemInstruction?: { parts?: Array<{ text?: string }> };
  contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }>;
  generationConfig?: { responseMimeType?: string; temperature?: number; maxOutputTokens?: number };
};

function readGeminiText(payload: unknown): string {
  const row = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const candidates = Array.isArray(row?.candidates) ? row.candidates : [];
  const first = candidates[0] && typeof candidates[0] === "object" ? (candidates[0] as Record<string, unknown>) : null;
  const content = first?.content && typeof first.content === "object" ? (first.content as Record<string, unknown>) : null;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  return parts
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("")
    .trim();
}

function toPromptParts(body: GeminiBody): { system: string; user: string } {
  const system = (body.systemInstruction?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  let hasImage = false;
  const user = (body.contents ?? [])
    .map((content) => {
      const chunks: string[] = [];
      for (const part of content.parts ?? []) {
        if (typeof part["text"] === "string") chunks.push(part["text"]);
        else if (part["inlineData"]) hasImage = true;
      }
      return chunks.join("\n");
    })
    .join("\n")
    .trim();
  return {
    system,
    user: hasImage
      ? `${user}\n\n(A reference photo was supplied but cannot be viewed by this model — infer a plausible, consistent subject from the written brief.)`.trim()
      : user,
  };
}

/** Plain-text Gemini completion used by the Co-Producer lyric assistant. */
export async function geminiGeneratePlainText(options: {
  system: string;
  user: string;
  label?: string;
  timeoutMs?: number;
  model?: string;
  apiKey?: string | null;
}): Promise<string> {
  const label = options.label ?? "Gemini";
  const model = options.model ?? aiFastModel();
  const url = geminiGenerateContentUrl(model, label, "free", options.apiKey ?? undefined);
  const response = await resilientFetch(
    url,
    {
      method: "POST",
      headers: geminiNativeHeaders(),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.system }] },
        contents: [{ role: "user", parts: [{ text: options.user }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
      }),
    },
    { label, timeoutMs: options.timeoutMs ?? 60_000, retries: 1, baseDelayMs: 800 },
  );

  if (response.status === 429) throw new Error(`${label} is busy right now. Try again in a moment.`);
  if (response.status === 402) throw new Error("AI credits are exhausted. Add credits and try again.");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${label} failed [${response.status}]: ${body.slice(0, 300)}`);
  }

  const payload: unknown = await response.json();
  const text = readGeminiText(payload);
  if (!text) throw new Error(`${label} returned nothing. Try a richer brief.`);
  return text;
}

export async function geminiGenerateContent(options: {
  model: string;
  body: unknown;
  label?: string;
  timeoutMs?: number;
  byokKey?: string | null;
}): Promise<Response> {
  const label = options.label ?? "AI assistant";
  const body = (options.body ?? {}) as GeminiBody;
  const { system, user } = toPromptParts(body);

  try {
    const text = await geminiGeneratePlainText({
      system,
      user,
      label,
      timeoutMs: options.timeoutMs ?? 60_000,
      model: options.model,
      apiKey: options.byokKey,
    });

    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text }], role: "model" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: { message: error instanceof Error ? error.message : `${label} failed.` },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
