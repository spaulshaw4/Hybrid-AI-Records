/**
 * Replicate LLM runtime (server only).
 *
 * Every text, script and prompt generation call in the platform — Engine 1.0
 * and the Visual Engine alike — runs through this module. It talks to the
 * Replicate HTTP API directly with `Authorization: Bearer ${LYRIC_ENGINE_API_KEY}`
 * and returns OpenAI- or Gemini-shaped responses so existing callers need no
 * changes. Hybrid Demucs / CWALO calls use REPLICATE_API_TOKEN instead.
 *
 * Video/motion token guards are untouched: this module is text-only.
 */

import { replicateBaseUrl } from "@/lib/ai-provider.server";
import { resilientFetch } from "@/lib/resilient-fetch.server";

/** Fast Gemini Flash text model for remaining chat completions. */
export const REPLICATE_LLM_MODEL =
  process.env["REPLICATE_LLM_MODEL"]?.trim() || "google/gemini-2.5-flash";

/** Official Google text model on Replicate, used by Co-Producer lyrics. */
export const REPLICATE_GEMINI_MODEL =
  process.env["REPLICATE_GEMINI_MODEL"]?.trim() || "google/gemini-2.5-flash";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function env(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const direct = process.env[name];
  if (direct?.trim()) return direct.trim();
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === wanted && value?.trim()) return value.trim();
  }
  return undefined;
}

const HYBRID_REPLICATE_ENV_NAMES = ["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"] as const;

/**
 * Isolated LLM / Co-Producer auth.
 * Reads only `process.env.LYRIC_ENGINE_API_KEY` (alias: `ENGINE_API_KEY`).
 * Never falls back to hybrid Demucs/CWALO `REPLICATE_API_TOKEN`.
 */
export function lyricEngineAuthToken(label = "The AI writer"): string {
  // Explicit process.env reads — do not use readEnv() hybrid aliases.
  const token =
    (typeof process !== "undefined" && process.env.LYRIC_ENGINE_API_KEY?.trim()) ||
    (typeof process !== "undefined" && process.env.ENGINE_API_KEY?.trim()) ||
    env("LYRIC_ENGINE_API_KEY") ||
    env("ENGINE_API_KEY") ||
    undefined;

  if (!token) {
    console.log("[Replicate LLM] Using LYRIC_ENGINE_API_KEY:", false);
    throw new Error(`${label} is not configured. Add LYRIC_ENGINE_API_KEY to .env.local.`);
  }

  const hybrid =
    (typeof process !== "undefined" && process.env.REPLICATE_API_TOKEN?.trim()) ||
    (typeof process !== "undefined" && process.env.REPLICATE_API_KEY?.trim()) ||
    undefined;
  if (hybrid && token === hybrid) {
    console.error(
      "[Replicate LLM] Refusing hybrid REPLICATE_API_TOKEN for LLM/Co-Producer — set a distinct LYRIC_ENGINE_API_KEY.",
    );
    throw new Error(
      `${label} misconfigured: LYRIC_ENGINE_API_KEY must not be the hybrid REPLICATE_API_TOKEN.`,
    );
  }

  for (const name of HYBRID_REPLICATE_ENV_NAMES) {
    // Guard against accidental future fallthrough in this module.
    if (token === env(name)) {
      throw new Error(
        `${label} misconfigured: refuse authenticating Gemini with ${name}.`,
      );
    }
  }

  console.log("[Replicate LLM] Using LYRIC_ENGINE_API_KEY:", true, `prefix=${token.slice(0, 3)}…`);
  return token;
}

/** @deprecated Prefer lyricEngineAuthToken — same isolated lyric/Gemini key. */
export function replicateLlmToken(label = "The AI writer"): string {
  return lyricEngineAuthToken(label);
}

/** Step 1 lyrics / Gemini Flash — isolated from REPLICATE_API_TOKEN (hybrid1). */
export function lyricReplicateToken(): string {
  try {
    return lyricEngineAuthToken("The Co-Producer");
  } catch (error) {
    if (error instanceof Error && /misconfigured/i.test(error.message)) throw error;
    throw new Error(
      "The Co-Producer is not configured. Add LYRIC_ENGINE_API_KEY to .env.local.",
    );
  }
}

/** Bearer headers for every Gemini / chat prediction — lyric engine key only. */
function headers(label?: string, token = lyricEngineAuthToken(label)): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/** Splits a chat transcript into Replicate's `system_prompt` + `prompt` inputs. */
function toReplicateInput(messages: ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const prompt = messages
    .filter((m) => m.role !== "system")
    .map((m) => (m.role === "assistant" ? `Assistant: ${m.content}` : m.content))
    .join("\n\n");
  return { system, prompt };
}

/** Joins a Replicate output stream, array, or object into plain text. */
export function joinReplicateOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((chunk) => joinReplicateOutput(chunk)).join("");
  if (output && typeof output === "object") {
    const row = output as Record<string, unknown>;
    if (typeof row.text === "string") return row.text;
    return "";
  }
  return output == null ? "" : String(output);
}

function isGoogleTextModel(model: string): boolean {
  const name = model.replace(/^google\//i, "").toLowerCase();
  return name.startsWith("gemini") || name.startsWith("gemma");
}

function predictionInput(
  model: string,
  system: string,
  prompt: string,
  options: { maxTokens?: number; temperature?: number; json?: boolean },
): Record<string, unknown> {
  const text = options.json
    ? `${prompt}\n\nRespond with valid JSON only. No prose, no markdown fences.`
    : prompt;
  if (isGoogleTextModel(model)) {
    return {
      prompt: text,
      ...(system ? { system_instruction: system } : {}),
      temperature: options.temperature ?? 0.7,
      max_output_tokens: options.maxTokens ?? 4096,
      thinking_budget: 0,
    };
  }
  return {
    prompt: text,
    ...(system ? { system_prompt: system } : {}),
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.7,
  };
}

/**
 * Runs one completion on Replicate and returns the raw text.
 * Creates the prediction, then polls until it settles.
 */
export async function replicateChat(
  messages: ChatMessage[],
  options: {
    label?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    json?: boolean;
  } = {},
): Promise<string> {
  const label = options.label ?? "AI writer";
  const model = options.model ?? REPLICATE_LLM_MODEL;
  const { system, prompt } = toReplicateInput(messages);
  const base = replicateBaseUrl();
  const auth = lyricEngineAuthToken(label);

  const create = await resilientFetch(
    `${base}/models/${model}/predictions`,
    {
      method: "POST",
      headers: headers(label, auth),
      body: JSON.stringify({
        input: predictionInput(model, system, prompt, options),
      }),
    },
    { label, retries: 2, timeoutMs: 120_000, baseDelayMs: 1500, respectRetryAfter: true },
  );

  if (!create.ok) {
    const body = await create.text().catch(() => "");
    if (create.status === 402) {
      throw new Error(
        `${label}: lyric-engine Replicate account (LYRIC_ENGINE_API_KEY) needs credit.`,
      );
    }
    throw new Error(`${label} failed [${create.status}]: ${body.slice(0, 400)}`);
  }

  let prediction = (await create.json()) as {
    id?: string;
    status?: string;
    output?: unknown;
    error?: string;
  };

  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  while (
    prediction.id &&
    prediction.status &&
    !["succeeded", "failed", "canceled"].includes(prediction.status)
  ) {
    if (Date.now() > deadline) throw new Error(`${label} timed out. Try again.`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const poll = await resilientFetch(
      `${base}/predictions/${prediction.id}`,
      { method: "GET", headers: headers(label, auth) },
      { label, retries: 2, timeoutMs: 30_000, baseDelayMs: 1000 },
    );
    if (!poll.ok) continue;
    prediction = (await poll.json()) as typeof prediction;
  }

  if (prediction.status !== "succeeded")
    throw new Error(`${label} failed: ${prediction.error ?? prediction.status ?? "unknown error"}`);

  return joinReplicateOutput(prediction.output).trim();
}

export const REPLICATE_GEMINI_FLASH = "google/gemini-2.5-flash";

/**
 * Co-Producer lyrics on Gemini 2.5 Flash via Replicate.
 * Authorization uses LYRIC_ENGINE_API_KEY only (not REPLICATE_API_TOKEN).
 */
export async function replicateGeminiFlashLyrics(input: {
  prompt: string;
  systemInstruction: string;
  timeoutMs?: number;
}): Promise<string> {
  const label = "Co-Producer";
  const base = replicateBaseUrl();
  const auth = lyricReplicateToken();
  const create = await resilientFetch(
    `${base}/models/${REPLICATE_GEMINI_FLASH}/predictions`,
    {
      method: "POST",
      headers: headers(label, auth),
      body: JSON.stringify({
        input: {
          prompt: input.prompt,
          system_instruction: input.systemInstruction,
          max_output_tokens: 2048,
          temperature: 0.7,
          thinking_budget: 0,
        },
      }),
    },
    { label, retries: 2, timeoutMs: 30_000, baseDelayMs: 1500, respectRetryAfter: true },
  );

  if (!create.ok) {
    const body = await create.text().catch(() => "");
    if (create.status === 402) {
      throw new Error(
        `${label} lyric-engine account has insufficient Replicate credit (LYRIC_ENGINE_API_KEY). Top up that account — not the hybrid Demucs token.`,
      );
    }
    throw new Error(`${label} failed [${create.status}]: ${body.slice(0, 400)}`);
  }

  let prediction = (await create.json()) as {
    id?: string;
    status?: string;
    output?: unknown;
    error?: string;
  };

  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  while (
    prediction.id &&
    prediction.status &&
    !["succeeded", "failed", "canceled"].includes(prediction.status)
  ) {
    if (Date.now() > deadline) throw new Error(`${label} timed out. Try again.`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const poll = await resilientFetch(
      `${base}/predictions/${prediction.id}`,
      { method: "GET", headers: headers(label, auth) },
      { label, retries: 2, timeoutMs: 30_000, baseDelayMs: 1000 },
    );
    if (!poll.ok) continue;
    prediction = (await poll.json()) as typeof prediction;
  }

  if (prediction.status !== "succeeded") {
    throw new Error(`${label} failed: ${prediction.error ?? prediction.status ?? "unknown error"}`);
  }

  return joinReplicateOutput(prediction.output).trim();
}

/** Runs a completion and returns an OpenAI chat-completions shaped Response. */
export async function replicateChatCompletionResponse(
  messages: ChatMessage[],
  options: Parameters<typeof replicateChat>[1] = {},
): Promise<Response> {
  try {
    const text = await replicateChat(messages, options);
    return new Response(
      JSON.stringify({
        id: `replicate-${Date.now()}`,
        model: options.model ?? REPLICATE_LLM_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: { message: error instanceof Error ? error.message : "AI request failed" } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
