import dotenv from "dotenv";

/**
 * Pipeline env lookup for TanStack Start / Vite.
 *
 * Vite `loadEnv` copies `.env*` into `process.env` at config load.
 * dotenv is a Node fallback when this module is imported outside Vite.
 *
 * The server entry's own `dotenv.config()` calls run *after* its
 * `import "./lib/env"` because ES imports hoist, so this module is what
 * actually populates `process.env` for the pipeline. `dotenv.config()` calls
 * `process.cwd()`, which does not exist in the browser, so it stays guarded.
 */
const isNodeRuntime = typeof process !== "undefined" && typeof process.cwd === "function";

if (isNodeRuntime) {
  dotenv.config({ path: ".env.local" });
  dotenv.config({ path: ".env.development" });
  dotenv.config({ path: ".env" });

  console.log(
    "[ENV_CHECK] Fish Audio Key loaded:",
    Boolean(process.env.FISH_API_KEY || process.env.FISH_AUDIO_API_KEY),
  );
}

export type PipelineStage =
  | "MusicAPI (Base Arrangement)"
  | "Stem Separation"
  | "Fish Audio (Vocals)"
  | "Mastering";

const KEY_ALIASES: Record<string, readonly string[]> = {
  MUSIC_API_KEY: [
    "AIMUSICAPI_KEY",
    "SONIC_API_KEY",
    "MUSICAPI_KEY",
    "AIMUSIC_API_KEY",
    "AI_MUSIC_API_KEY",
  ],
  AIMUSICAPI_KEY: ["AI_MUSIC_API_KEY", "MUSIC_API_KEY", "AIMUSIC_API_KEY", "MUSICAPI_KEY", "SONIC_API_KEY"],
  AIMUSIC_API_KEY: ["AIMUSICAPI_KEY", "AI_MUSIC_API_KEY", "MUSIC_API_KEY", "MUSICAPI_KEY", "SONIC_API_KEY"],
  AI_MUSIC_API_KEY: ["AIMUSICAPI_KEY", "AIMUSIC_API_KEY", "MUSIC_API_KEY", "MUSICAPI_KEY", "SONIC_API_KEY"],
  FISH_AUDIO_API_KEY: ["FISH_API_KEY"],
  FISH_API_KEY: ["FISH_AUDIO_API_KEY"],
  REPLICATE_API_TOKEN: ["REPLICATE_API_KEY", "ENGINE_API_KEY", "LYRIC_ENGINE_API_KEY"],
  REPLICATE_API_KEY: ["REPLICATE_API_TOKEN", "ENGINE_API_KEY", "LYRIC_ENGINE_API_KEY"],
  ENGINE_API_KEY: ["REPLICATE_API_KEY", "REPLICATE_API_TOKEN", "LYRIC_ENGINE_API_KEY"],
  LYRIC_ENGINE_API_KEY: ["REPLICATE_API_KEY", "ENGINE_API_KEY"],
  GEMINI_API_KEY: ["GOOGLE_API_KEY"],
};

function trimEnv(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const next = value.trim();
  return next || undefined;
}

function viteEnv(): Record<string, unknown> | undefined {
  try {
    return (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  } catch {
    return undefined;
  }
}

function fromProcess(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return trimEnv(process.env[name]);
}

function fromImportMeta(name: string): string | undefined {
  return trimEnv(viteEnv()?.[name]);
}

function readNamedKey(keyName: string): string | undefined {
  return (
    fromProcess(keyName) ||
    fromProcess(`VITE_${keyName}`) ||
    fromImportMeta(keyName) ||
    fromImportMeta(`VITE_${keyName}`)
  );
}

/** Optional lookup — does not throw. Also checks known aliases. */
export function readEnv(keyName: string): string | undefined {
  const names = [keyName, ...(KEY_ALIASES[keyName] ?? [])];
  for (const name of names) {
    const value = readNamedKey(name);
    if (value) return value;
  }
  return undefined;
}

export function requireStageKey(keyName: string, stage: string): string {
  const trimmed = readEnv(keyName);
  if (!trimmed) {
    const errorMsg = `[PIPELINE_INIT_FAILED] ${stage} failed: Missing ${keyName}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  return trimmed;
}

export function getEnvKey(keyName: string, stage = keyName): string {
  return requireStageKey(keyName, stage);
}

/** Official Fish Audio key. Prefers FISH_AUDIO_API_KEY, then FISH_API_KEY. */
export function getFishApiKey(): string | undefined {
  return readEnv("FISH_AUDIO_API_KEY") || readEnv("FISH_API_KEY");
}

export function requireFishApiKey(): string {
  const apiKey = getFishApiKey();
  if (!apiKey) {
    console.error(
      "[FISH_AUDIO] FISH_API_KEY / FISH_AUDIO_API_KEY is undefined — add it to .env.local",
    );
    throw new Error("Missing FISH_API_KEY in .env.local");
  }
  return apiKey;
}
