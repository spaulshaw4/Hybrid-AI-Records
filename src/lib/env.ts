import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.development" });
dotenv.config({ path: ".env" });

/**
 * Pipeline env lookup for TanStack Start / Vite.
 *
 * Vite `loadEnv` copies `.env*` into `process.env` at config load.
 * dotenv is a Node fallback when this module is imported outside Vite.
 */

export type PipelineStage =
  | "MusicAPI (Base Arrangement)"
  | "Stem Separation"
  | "Fish Audio (Vocals)"
  | "Mastering";

const KEY_ALIASES: Record<string, readonly string[]> = {
  MUSIC_API_KEY: ["SONIC_API_KEY", "MUSICAPI_KEY"],
  FISH_AUDIO_API_KEY: ["FISH_API_KEY"],
  FISH_API_KEY: ["FISH_AUDIO_API_KEY"],
  REPLICATE_API_TOKEN: ["REPLICATE_API_KEY"],
  REPLICATE_API_KEY: ["REPLICATE_API_TOKEN"],
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
  const meta = viteEnv();
  const value =
    process.env[keyName] ||
    process.env[`VITE_${keyName}`] ||
    (typeof import.meta !== "undefined" && meta?.[keyName]) ||
    (typeof import.meta !== "undefined" && meta?.[`VITE_${keyName}`]) ||
    readEnv(keyName);
  const trimmed = trimEnv(value);
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
