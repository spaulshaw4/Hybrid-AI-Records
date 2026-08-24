/**
 * External AI provider configuration (server only).
 *
 * The project no longer routes any LLM, vision, image or generation traffic
 * through a managed platform gateway. Every call in the pipeline resolves its
 * base URL, credentials and model ids from this module, which reads plain
 * environment variables you control:
 *
 *   LLM / vision / image (OpenAI-compatible chat-completions API)
 *     AI_API_BASE_URL     e.g. https://api.openai.com/v1
 *                              https://openrouter.ai/api/v1
 *                              https://generativelanguage.googleapis.com/v1beta/openai
 *     AI_API_KEY          your own provider key (aliases: OPENAI_API_KEY,
 *                         OPENROUTER_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY)
 *     AI_TEXT_MODEL / AI_VISION_MODEL / AI_IMAGE_MODEL / AI_FAST_MODEL
 *                         optional model-id overrides
 *
 *   Motion / audio generation (Replicate, called directly)
 *     REPLICATE_API_BASE_URL   defaults to https://api.replicate.com/v1
 *     REPLICATE_API_TOKEN      hybrid1 token for Demucs / CWALO (alias: REPLICATE_API_KEY)
 *     LYRIC_ENGINE_API_KEY     Gemini 2.5 Flash / Co-Producer only
 *
 *   Instant vocal clone (Fish Audio TTS)
 *     FISH_API_KEY             official Fish Audio key (alias: FISH_AUDIO_API_KEY)

 *
 * No platform key is read anywhere, so no platform credits can be consumed —
 * including by background render loops and scheduled work.
 */

import {
  FAST_WORKER_MODEL,
  ORCHESTRATOR_IMAGE_MODEL,
  ORCHESTRATOR_MODEL,
  ORCHESTRATOR_VISION_MODEL,
} from "@/lib/orchestrator-models";

/**
 * Reads an environment variable case-insensitively.
 *
 * The vault stores some credentials with mixed casing (e.g. `Gemini_API_Key`,
 * `Replicate_API_Key`) while the pipeline asks for the canonical upper-case
 * name. Matching on a normalised key means either spelling resolves and no job
 * fails with "not configured" while a valid credential sits in the vault.
 */
function env(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const direct = process.env[name];
  if (direct && direct.trim()) return direct.trim();
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === wanted && value && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Two strictly separated credentials:
 *
 *  - `GEMINI_FREE_API_KEY` — the free Hybrid tier. Script writing, lyrics
 *    parsing, scene/shot prompt planning, style tuning and metadata analysis
 *    run on this key ONLY, so no free task can ever touch paid billing.
 *  - `GOOGLE_PAID_API_KEY` — paid generation routes tied to Video Tokens.
 *    Nothing reads it unless the caller's V Token balance was verified and
 *    charged first.
 */
export type AiTier = "free" | "paid";

/**
 * Chat/completion credentials, in resolution order.
 *
 * Every text completion (Engine 1.0 and Visual Engine alike) now runs on
 * GOOGLE_PAID_API_KEY first for high-RPM throughput and no 429 quota walls;
 * the older keys stay as fallbacks so nothing breaks if it is unset.
 */
const FREE_KEY_NAMES = [
  "GOOGLE_PAID_API_KEY",
  "GEMINI_FREE_API_KEY",
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

/**
 * Paid-tier credentials, in resolution order. The platform key comes first;
 * the other Google credentials are fallbacks so a single mis-provisioned key
 * can never take the Visual Engine offline.
 */
const PAID_KEY_NAMES = ["GOOGLE_PAID_API_KEY", "GEMINI_API_KEY", "GEMINI_FREE_API_KEY"] as const;


function keyNames(tier: AiTier) {
  return tier === "paid" ? PAID_KEY_NAMES : FREE_KEY_NAMES;
}

/** True when the free Hybrid tier credential is present. */
export function hasFreeAiKey(): boolean {
  return FREE_KEY_NAMES.some((name) => Boolean(env(name)));
}

/** True when the paid generation credential is present. */
export function hasPaidAiKey(): boolean {
  return PAID_KEY_NAMES.some((name) => Boolean(env(name)));
}

/** Back-compat alias: free-tier LLM credentials are present. */
export function hasExternalAiKey(): boolean {
  return hasFreeAiKey();
}

/** Provider key for the requested tier. Throws a clear, user-facing message when unset. */
export function aiApiKey(label = "AI", tier: AiTier = "free"): string {
  for (const name of keyNames(tier)) {
    const value = env(name);
    if (value) return value;
  }
  throw new Error(
    tier === "paid"
      ? `${label} is not configured: save GOOGLE_PAID_API_KEY in the secrets vault (paid generation only).`
      : `${label} is not configured: save GEMINI_FREE_API_KEY in the secrets vault.`,
  );
}

/** Base URL of the OpenAI-compatible endpoint for the tier. */
export function aiBaseUrl(tier: AiTier = "free"): string {
  if (tier === "paid") {
    return (env("GOOGLE_PAID_API_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(
      /\/+$/,
      "",
    );
  }
  // Completions run on the paid Google key by default — same endpoint as the paid tier.
  if (env("GOOGLE_PAID_API_KEY")) {
    return (env("GOOGLE_PAID_API_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(
      /\/+$/,
      "",
    );
  }
  const explicit = env("AI_API_BASE_URL") ?? env("OPENAI_BASE_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  if (env("GEMINI_FREE_API_KEY")) return "https://generativelanguage.googleapis.com/v1beta/openai";
  if (env("OPENROUTER_API_KEY")) return "https://openrouter.ai/api/v1";
  if (env("GEMINI_API_KEY")) return "https://generativelanguage.googleapis.com/v1beta/openai";
  return "https://api.openai.com/v1";
}

/** Full chat-completions URL for the tier's provider. */
export function aiChatUrl(tier: AiTier = "free"): string {
  return `${aiBaseUrl(tier)}/chat/completions`;
}

/**
 * Ordered platform credentials for native Gemini REST, best first.
 *
 * Server/vault keys are always the default. A user-supplied (BYOK) key is only
 * consulted when it is explicitly passed in — there is no client preflight and
 * no requirement for the user to save anything in Settings.
 */
export function geminiNativeKeys(byokKey?: string | null): string[] {
  const platform = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_PAID_API_KEY", "GEMINI_FREE_API_KEY"]
    .map((name) => env(name)?.trim())
    .filter((value): value is string => Boolean(value));
  const byok = byokKey?.trim();
  const ordered = byok ? [byok, ...platform] : platform;
  return Array.from(new Set(ordered));
}

/**
 * Native Gemini generateContent URL. Native REST authenticates only through
 * the `key` query parameter here; never attach a Bearer token to this URL.
 */
export function geminiGenerateContentUrl(
  model: string,
  label = "Gemini",
  _tier: AiTier = "paid",
  apiKey?: string,
): string {
  const key = apiKey?.trim() || geminiNativeKeys()[0];
  if (!key) {
    console.error("[Gemini Auth] No Google API key present in environment");
    throw new Error(`${label} is not configured: no Google API key is available on the server.`);
  }
  const nativeModel = model.replace(/^google\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(nativeModel)}:generateContent?key=${encodeURIComponent(key)}`;
}


/**
 * Native Gemini REST headers. Authentication is supplied exclusively by the
 * `?key=` URL parameter built by `geminiGenerateContentUrl`.
 */
export function geminiNativeHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}


/** True when the tier resolves to Google's OpenAI-compatible shim (/v1beta/openai). */
export function isGeminiOpenAiCompatRoute(tier: AiTier = "free"): boolean {
  return isGeminiRoute(tier) && /\/v1beta\/openai\b/.test(aiBaseUrl(tier));
}

/**
 * Auth + content headers for the tier's provider.
 *
 * Google accepts two different auth shapes and rejects the wrong one:
 *  - OpenAI-compatible shim (`/v1beta/openai/chat/completions`) requires
 *    `Authorization: Bearer <API key>` (400 "Missing or invalid Authorization header" otherwise).
 *  - Native REST (`/v1beta/models/...:generateContent`) requires `x-goog-api-key`
 *    (401 ACCESS_TOKEN_TYPE_UNSUPPORTED when sent as a Bearer token).
 */
export function aiHeaders(label = "AI", tier: AiTier = "free"): Record<string, string> {
  const key = aiApiKey(label, tier).trim();
  if (!key) {
    throw new Error(`${label} is not configured: GOOGLE_PAID_API_KEY resolved to an empty value.`);
  }
  if (isGeminiRoute(tier) && !isGeminiOpenAiCompatRoute(tier)) {
    // Native Gemini REST — plain API key header.
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    };
  }
  // OpenAI-compatible endpoints (Google shim, OpenAI, OpenRouter) — Bearer.
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}



/**
 * Guard for paid generation routes: never dispatch against the paid key unless
 * it is actually configured (and the caller already paid in Video Tokens).
 */
export function assertPaidAiKey(label = "Paid generation"): void {
  if (!hasPaidAiKey()) {
    throw new Error(`${label} is not configured: save GOOGLE_PAID_API_KEY in the secrets vault.`);
  }
}

/** True when a Gemini credential is the active LLM path. */
export function isGeminiRoute(tier: AiTier = "free"): boolean {
  return aiBaseUrl(tier).includes("generativelanguage.googleapis.com");
}

/**
 * Model ids are stored OpenRouter-style (`google/gemini-…`). Google's own
 * OpenAI-compatible endpoint rejects the vendor prefix, so strip it whenever
 * the request is routed straight at Gemini.
 */
export function normalizeModelId(model: string, tier: AiTier = "free"): string {
  return isGeminiRoute(tier) ? model.replace(/^google\//, "") : model;
}

/** Model ids, overridable per tier without touching pipeline code. */
export function aiTextModel(): string {
  return normalizeModelId(env("AI_TEXT_MODEL") ?? ORCHESTRATOR_MODEL);
}
export function aiVisionModel(): string {
  return normalizeModelId(env("AI_VISION_MODEL") ?? env("AI_TEXT_MODEL") ?? ORCHESTRATOR_VISION_MODEL);
}
export function aiImageModel(): string {
  return normalizeModelId(env("AI_IMAGE_MODEL") ?? ORCHESTRATOR_IMAGE_MODEL);
}
export function aiFastModel(): string {
  return normalizeModelId(env("AI_FAST_MODEL") ?? env("AI_TEXT_MODEL") ?? FAST_WORKER_MODEL);
}

/* ------------------------------------------------------------------ */
/* Generation providers (Replicate, direct)                            */
/* ------------------------------------------------------------------ */

export function replicateBaseUrl(): string {
  return (env("REPLICATE_API_BASE_URL") ?? "https://api.replicate.com/v1").replace(/\/+$/, "");
}

/**
 * Hybrid Replicate token for Demucs / CWALO (and other non-Gemini jobs).
 * Prefers REPLICATE_API_TOKEN (hybrid1); falls back to REPLICATE_API_KEY only.
 * Never reads LYRIC_ENGINE_API_KEY.
 */
export function hasReplicateKey(): boolean {
  return Boolean(env("REPLICATE_API_TOKEN") ?? env("REPLICATE_API_KEY"));
}

export function replicateApiKey(label = "The generation engine"): string {
  const key = env("REPLICATE_API_TOKEN") ?? env("REPLICATE_API_KEY");
  if (!key) {
    throw new Error(`${label} is not configured: set REPLICATE_API_TOKEN to your hybrid1 token.`);
  }
  return key;
}

export function replicateHeaders(label?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${replicateApiKey(label)}`,
  };
}

