/**
 * Style Prompt Optimizer — Gemini 2.5 Flash on Replicate.
 * Turns freeform genre concepts into 100K Prompt Book style-tag strings
 * for Gate 1 `tags`.
 */

import { replicateBaseUrl, replicateApiKey } from "@/lib/ai-provider.server";
import {
  joinReplicateOutput,
  REPLICATE_GEMINI_FLASH,
} from "@/lib/replicate-llm.server";
import { resilientFetch } from "@/lib/resilient-fetch.server";

const OPTIMIZER_LABEL = "Style Prompt Optimizer";
const MAX_USER_TEXT = 4000;

/** 100K Prompt Book instruction wrapped around the artist's concept. */
export function buildStyleOptimizePrompt(userText: string): string {
  const concept = userText.trim().slice(0, MAX_USER_TEXT);
  return `You are an expert audio engineer and music producer. Transform this user concept into a single, highly structured style tag string following the 100K Prompt Book formula:
[Genre/Sub-genre], [BPM], [Vocal Role], [Mood/Energy]; [Lead Hook Instrument] carries the hook while [Rhythm Bed Instrument] fills the space — theme: [Concept]
Return ONLY the raw prompt string without markdown formatting, quotes, or conversational filler.
User Concept: "${concept}"`;
}

/** Strip markdown fences / wrapping quotes Gemini sometimes adds. */
export function cleanOptimizedStylePrompt(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:[\w-]*)?\s*/i, "").replace(/\s*```$/i, "");
  text = text.replace(/^["'`]+|["'`]+$/g, "").trim();
  // Drop a leading label if the model still narrates.
  text = text.replace(/^(?:here(?:'s| is)|optimized(?: style)?(?: prompt)?)\s*[:\-–—]\s*/i, "");
  return text.replace(/\s+/g, " ").trim();
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${replicateApiKey(OPTIMIZER_LABEL)}`,
  };
}

/**
 * Runs google/gemini-2.5-flash via Replicate with REPLICATE_API_TOKEN
 * (alias: REPLICATE_API_KEY).
 */
export async function optimizeStylePromptViaGemini(
  userText: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const trimmed = userText.trim();
  if (trimmed.length < 2) {
    throw new Error("Add a short style concept before optimizing.");
  }

  const prompt = buildStyleOptimizePrompt(trimmed);
  const base = replicateBaseUrl();
  const headers = authHeaders();

  const create = await resilientFetch(
    `${base}/models/${REPLICATE_GEMINI_FLASH}/predictions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: {
          prompt,
          temperature: 0.4,
          max_output_tokens: 512,
          thinking_budget: 0,
        },
      }),
    },
    {
      label: OPTIMIZER_LABEL,
      retries: 2,
      timeoutMs: 60_000,
      baseDelayMs: 1500,
      respectRetryAfter: true,
    },
  );

  if (!create.ok) {
    const body = await create.text().catch(() => "");
    throw new Error(`${OPTIMIZER_LABEL} failed [${create.status}]: ${body.slice(0, 400)}`);
  }

  let prediction = (await create.json()) as {
    id?: string;
    status?: string;
    output?: unknown;
    error?: string;
  };

  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (
    prediction.id &&
    prediction.status &&
    !["succeeded", "failed", "canceled"].includes(prediction.status)
  ) {
    if (Date.now() > deadline) {
      throw new Error(`${OPTIMIZER_LABEL} timed out. Try again.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const poll = await resilientFetch(
      `${base}/predictions/${prediction.id}`,
      { method: "GET", headers },
      { label: OPTIMIZER_LABEL, retries: 2, timeoutMs: 20_000, baseDelayMs: 800 },
    );
    if (!poll.ok) continue;
    prediction = (await poll.json()) as typeof prediction;
  }

  if (prediction.status !== "succeeded") {
    throw new Error(
      `${OPTIMIZER_LABEL} failed: ${prediction.error ?? prediction.status ?? "unknown error"}`,
    );
  }

  const cleaned = cleanOptimizedStylePrompt(joinReplicateOutput(prediction.output));
  if (!cleaned) {
    throw new Error(`${OPTIMIZER_LABEL} returned an empty prompt.`);
  }
  return cleaned.slice(0, 6000);
}
