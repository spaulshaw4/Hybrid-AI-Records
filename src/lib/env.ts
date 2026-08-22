import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config(); // fallback to .env

/**
 * Pipeline env lookup for TanStack Start / Vite.
 *
 * dotenv loads `.env.local` then `.env` into Node `process.env`.
 * Dynamic `process.env[name]` access so Vite cannot statically replace
 * server secrets with `undefined`. Optional `VITE_` copies stay as fallbacks.
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

function fromProcess(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return trimEnv(process.env[name]);
}

function fromImportMeta(name: string): string | undefined {
  try {
    const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
    return trimEnv(env?.[name]);
  } catch {
    return undefined;
  }
}

function readNamedKey(keyName: string): string | undefined {
  return (
    fromProcess(keyName) ||
    fromProcess(`VITE_${keyName}`) ||
    fromImportMeta(`VITE_${keyName}`) ||
    fromImportMeta(keyName)
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
  const value =
    process.env[keyName] ||
    process.env[`VITE_${keyName}`] ||
    (typeof import.meta !== "undefined" && import.meta.env?.[`VITE_${keyName}`]) ||
    (typeof import.meta !== "undefined" && import.meta.env?.[keyName]) ||
    readEnv(keyName);
  const trimmed = trimEnv(value);
  if (!trimmed) {
    const errorMsg = `[PIPELINE_INIT_FAILED] ${stage} failed: Environment variable '${keyName}' is missing.`;
    console.error(errorMsg);
    console.log(
      "Available keys in process.env:",
      Object.keys(process.env ?? {}).filter((k) => !k.includes("npm_") && !k.includes("SECRET")),
    );
    throw new Error(errorMsg);
  }
  return trimmed;
}
