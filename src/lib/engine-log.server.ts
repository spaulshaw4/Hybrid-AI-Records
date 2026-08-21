/**
 * Structured logging for the music engine (server-only).
 *
 * Every log line is a single JSON object on stdout so it can be grepped and
 * grouped by `correlationId` across a whole generation: request, each retry
 * attempt, and any circuit-breaker state transition.
 */

import { producerLogFields } from "@/lib/producer-identity";

export type EngineLogLevel = "info" | "warn" | "error";

export type EngineLogFields = Record<string, unknown>;

/** Correlation ID shared by every log line of one engine operation. */
export function newCorrelationId(prefix = "eng"): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** Never log credentials, prompts or lyrics — only shapes and lengths. */
const REDACTED = new Set(["authorization", "x-connection-api-key", "apikey", "lyrics", "prompt"]);

function safeFields(fields: EngineLogFields): EngineLogFields {
  const out: EngineLogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED.has(key.toLowerCase())) {
      out[key] = typeof value === "string" ? `[redacted:${value.length}]` : "[redacted]";
      continue;
    }
    out[key] = value instanceof Error ? value.message : value;
  }
  return out;
}

export function engineLog(
  level: EngineLogLevel,
  event: string,
  correlationId: string,
  fields: EngineLogFields = {},
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    scope: "music-engine",
    level,
    event,
    correlationId,
    ...producerLogFields(),
    ...safeFields(fields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  // Info lines are diagnostics only — never emitted in production builds so
  // request/payload shapes stay out of production logs.
  else if (process.env["NODE_ENV"] !== "production") console.info(line);
}

/** Non-reversible short digest so identical payloads can be correlated. */
function digest(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Structural summary of the lyrics parameter. The lyric text itself is never
 * logged — only section tags, sizes and a digest, which is enough to diagnose
 * a rejected Replicate request without leaking a writer's words.
 */
export function summarizeLyricsParam(lyrics: string) {
  const lines = lyrics.split("\n");
  const sections = (lyrics.match(/\[[^\]]{1,40}\]/g) ?? []).map((t) => t.trim());
  return {
    length: lyrics.length,
    lineCount: lines.length,
    wordCount: lyrics.trim() ? lyrics.trim().split(/\s+/).length : 0,
    sections,
    sectionCount: sections.length,
    hasBracketedSections: sections.length > 0,
    startsWithSection: /^\s*\[/.test(lyrics),
    trailingWhitespace: lyrics !== lyrics.trim(),
    digest: digest(lyrics),
  };
}

/**
 * The final engine payload as sent to Replicate. `prompt` carries only
 * genre/style tags (no user lyric text), so it is logged verbatim for
 * diagnosis; lyrics are redacted down to their structure.
 */
export function logEnginePayload(
  correlationId: string,
  payload: { prompt: string; lyrics: string; instrumental: boolean; model?: string; audioFormat?: string },
): void {
  engineLog("info", "payload.final", correlationId, {
    model: payload.model ?? null,
    audioFormat: payload.audioFormat ?? null,
    instrumental: payload.instrumental,
    promptText: payload.prompt,
    promptLength: payload.prompt.length,
    promptTagCount: payload.prompt.split(",").map((t) => t.trim()).filter(Boolean).length,
    promptTruncated: payload.prompt.length >= 600,
    lyricsParam: summarizeLyricsParam(payload.lyrics),
  });
}

