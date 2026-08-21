/**
 * Native-shaped generateContent dispatcher (server only).
 *
 * The runtime behind it is Replicate (`meta/meta-llama-3-8b-instruct` by
 * default) authenticated with REPLICATE_API_TOKEN. The Gemini-style request
 * body and response envelope are preserved so callers such as the Character
 * Assistant need no changes.
 *
 * Note: the text model is not multimodal — inline image parts are described in
 * text rather than sent, and the model invents from the surrounding brief.
 */

import { replicateChat } from "@/lib/replicate-llm.server";
import type { ChatMessage } from "@/lib/replicate-llm.server";

type GeminiBody = {
  systemInstruction?: { parts?: Array<{ text?: string }> };
  contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }>;
  generationConfig?: { responseMimeType?: string; temperature?: number; maxOutputTokens?: number };
};

function toMessages(body: GeminiBody): { messages: ChatMessage[]; hasImage: boolean } {
  const messages: ChatMessage[] = [];
  let hasImage = false;

  const system = (body.systemInstruction?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (system) messages.push({ role: "system", content: system });

  for (const content of body.contents ?? []) {
    const text: string[] = [];
    for (const part of content.parts ?? []) {
      if (typeof part["text"] === "string") text.push(part["text"]);
      else if (part["inlineData"]) hasImage = true;
    }
    if (hasImage)
      text.push(
        "(A reference photo was supplied but cannot be viewed by this model — infer a plausible, consistent subject from the written brief.)",
      );
    const joined = text.join("\n").trim();
    if (joined)
      messages.push({ role: content.role === "model" ? "assistant" : "user", content: joined });
  }

  return { messages, hasImage };
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
  const { messages } = toMessages(body);

  try {
    const text = await replicateChat(messages, {
      label,
      timeoutMs: options.timeoutMs ?? 300_000,
      json: body.generationConfig?.responseMimeType === "application/json",
      ...(typeof body.generationConfig?.temperature === "number"
        ? { temperature: body.generationConfig.temperature }
        : {}),
      ...(body.generationConfig?.maxOutputTokens
        ? { maxTokens: body.generationConfig.maxOutputTokens }
        : {}),
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
