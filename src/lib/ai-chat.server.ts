/**
 * Single entry point for every chat/completion call (server only).
 *
 * All LLM traffic — Engine 1.0 and the Visual Engine — now runs on Replicate
 * (`google/gemini-2.5-flash` by default) using LYRIC_ENGINE_API_KEY. The
 * function keeps its OpenAI-compatible request/response contract so every
 * existing caller works unchanged.
 */

import type { AiTier } from "@/lib/ai-provider.server";
import {
  replicateChatCompletionResponse,
  type ChatMessage,
} from "@/lib/replicate-llm.server";

export type AiChatOptions = {
  label?: string;
  /** Extra attempts after the first. Retries are handled inside the Replicate client. */
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  /** Kept for API compatibility; Replicate is a single billing route. */
  tier?: AiTier;
};

/** POSTs an OpenAI-shaped chat body and returns an OpenAI-shaped Response. */
export async function aiChatFetch(
  init: { body: string; headers?: Record<string, string> },
  options: AiChatOptions = {},
): Promise<Response> {
  const { label = "AI", timeoutMs = 300_000 } = options;

  let parsed: {
    messages?: ChatMessage[];
    max_tokens?: number;
    temperature?: number;
    response_format?: { type?: string };
  } = {};
  try {
    parsed = JSON.parse(init.body) as typeof parsed;
  } catch {
    return new Response(JSON.stringify({ error: { message: `${label}: malformed request body.` } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const messages = (parsed.messages ?? []).filter(
    (m): m is ChatMessage => typeof m?.content === "string",
  );

  return replicateChatCompletionResponse(messages, {
    label,
    timeoutMs,
    ...(parsed.max_tokens ? { maxTokens: parsed.max_tokens } : {}),
    ...(typeof parsed.temperature === "number" ? { temperature: parsed.temperature } : {}),
    json: parsed.response_format?.type === "json_object",
  });
}
