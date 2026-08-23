import fs from "node:fs";

const file = "C:/Users/spaul/Downloads/Hybrid AI Forge (10)/src/lib/music-generation.ts";
let t = fs.readFileSync(file, "utf8");

const constStart = t.indexOf("export const AIMUSICAPI_BASE_URL");
const constEnd = t.indexOf("export type StudioTrackOptions");
if (constStart < 0 || constEnd < 0) {
  console.error("const block missing", { constStart, constEnd });
  process.exit(1);
}

const constants = `/** Primary MusicAPI host (active credit balance). */
export const MUSICAPI_BASE_URL = "https://api.musicapi.ai";
/** Fallback AIMusicAPI host. */
export const AIMUSICAPI_BASE_URL = "https://api.aimusicapi.ai";
/** Primary Sonic create endpoint. */
export const MUSICAPI_CREATE_URL = \`\${MUSICAPI_BASE_URL}/api/v1/sonic/create\`;
/** Fallback Sonic create endpoint. */
export const AIMUSICAPI_CREATE_URL = \`\${AIMUSICAPI_BASE_URL}/api/v1/sonic/create\`;
/** Primary Sonic task poll base (append /\${taskId}). */
export const MUSICAPI_TASK_URL = \`\${MUSICAPI_BASE_URL}/api/v1/sonic/task\`;
/** Fallback Sonic task poll base. */
export const AIMUSICAPI_TASK_URL = \`\${AIMUSICAPI_BASE_URL}/api/v1/sonic/task\`;
/** Canonical create URL (primary). */
export const SONIC_CREATE_URL = MUSICAPI_CREATE_URL;
/** Canonical task URL (primary). */
export const SONIC_TASK_URL = MUSICAPI_TASK_URL;
/** @deprecated Alias for create URL. */
export const SUNO_CREATE_URL = MUSICAPI_CREATE_URL;
/** @deprecated Alias for task URL. */
export const SUNO_TASK_URL = MUSICAPI_TASK_URL;
/** Official MusicAPI / AIMusicAPI auth scheme. */
export const AIMUSICAPI_HEADER_FORMAT = "Authorization: Bearer";
/** Minimum abort window for Sonic create + poll HTTP calls. */
export const AIMUSICAPI_FETCH_TIMEOUT_MS = 60_000;
/** Locked Sonic v5 model id. Supports vocal_gender. */
export const SONIC_MODEL = "sonic-v5" as const;
/** @deprecated Use SONIC_MODEL. */
export const SUNO_MODEL = SONIC_MODEL;

export type SonicModel = typeof SONIC_MODEL;

`;

t = t.slice(0, constStart) + constants + t.slice(constEnd);
t = t.replaceAll("chirp-v5", "sonic-v5");
t = t.replaceAll("typeof SUNO_MODEL", "typeof SONIC_MODEL");
t = t.replaceAll("mv: SUNO_MODEL", "mv: SONIC_MODEL");

const keyStart = t.indexOf("export function getMusicApiKey(): string {");
const keyEnd = t.indexOf("function musicApiKeyPrefix");
if (keyStart < 0 || keyEnd < 0) {
  console.error("getMusicApiKey missing");
  process.exit(1);
}

const keyFn = `export function getMusicApiKey(): string {
  const apiKey =
    trimProcessEnv("AIMUSICAPI_KEY") ||
    trimProcessEnv("MUSICAPI_KEY") ||
    trimProcessEnv("MUSIC_API_KEY") ||
    trimProcessEnv("AI_MUSIC_API_KEY") ||
    readEnv("AIMUSICAPI_KEY") ||
    readEnv("MUSICAPI_KEY") ||
    readEnv("MUSIC_API_KEY") ||
    readEnv("AI_MUSIC_API_KEY") ||
    readEnv("AIMUSIC_API_KEY") ||
    trimProcessEnv("ENGINE_API_KEY");
  if (!apiKey) {
    console.error(
      "[MUSICAPI] AIMUSICAPI_KEY / MUSICAPI_KEY / MUSIC_API_KEY is undefined — add it to .env.local",
    );
    return requireStageKey("MUSIC_API_KEY", MUSIC_STAGE);
  }
  return apiKey;
}

`;

t = t.slice(0, keyStart) + keyFn + t.slice(keyEnd);

// Payload type: drop task_type requirement to match strict MusicAPI body
t = t.replace(
  /\/\*\* Strict AIMusicAPI Suno v5 create body \(docs\)\. \*\/\nexport type SonicCreatePayload = \{[\s\S]*?\};/,
  `/** Strict MusicAPI Sonic v5 create body. */
export type SonicCreatePayload = {
  custom_mode: true;
  mv: typeof SONIC_MODEL;
  prompt: string;
  tags: string;
  title: string;
  vocal_gender?: SonicVocalGender;
};`,
);

// buildSonicCreatePayload
const buildStart = t.indexOf("/** Strict Suno v5 create body");
const buildAlt = t.indexOf("export function buildSonicCreatePayload");
const buildFrom = buildStart >= 0 ? buildStart : buildAlt;
const buildEnd = t.indexOf("function previewBody");
if (buildFrom < 0 || buildEnd < 0) {
  console.error("buildSonicCreatePayload missing", { buildFrom, buildEnd });
  process.exit(1);
}

const buildFn = `/** Strict Sonic v5 create body — caller \`mv\` is ignored. */
export function buildSonicCreatePayload(options: StudioTrackOptions): SonicCreatePayload {
  const gender = normalizeVocalGender(options.vocal_gender || options.vocalGender);
  let tags = options.tags?.trim() || styleTags(options) || options.genre || "";
  if (gender) tags = appendGenderTag(tags, gender);

  const payload: SonicCreatePayload = {
    custom_mode: true,
    mv: SONIC_MODEL,
    prompt: options.lyrics ?? "",
    tags,
    title: options.title || "Studio Master",
  };

  if (gender) {
    payload.vocal_gender = gender;
  } else {
    delete payload.vocal_gender;
  }

  return cleanSonicPayload(payload);
}

`;

t = t.slice(0, buildFrom) + buildFn + t.slice(buildEnd);

// postSonicCreate with primary+fallback + MUSICAPI_DISPATCH
const postStart = t.indexOf("async function postSonicCreate(");
const postEnd = t.indexOf("export async function generateStudioTrack(");
if (postStart < 0 || postEnd < 0) {
  console.error("postSonicCreate missing", { postStart, postEnd });
  process.exit(1);
}

const postFn = `function musicApiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: \`Bearer \${apiKey}\`,
    "Content-Type": "application/json",
  };
}

async function postSonicCreate(
  payload: SonicCreatePayload,
  apiKey: string,
  abortSignal?: AbortSignal,
): Promise<{ response: Response; raw: unknown; endpoint: string }> {
  const lyricsPrompt = payload.prompt;
  const styleTags = payload.tags;
  const trackTitle = payload.title;
  const vocalGender = normalizeVocalGender(payload.vocal_gender);

  const dispatchPayload: Record<string, unknown> = {
    custom_mode: true,
    mv: "sonic-v5",
    prompt: lyricsPrompt,
    tags: styleTags,
    title: trackTitle,
    ...(vocalGender ? { vocal_gender: vocalGender } : {}),
  };

  console.log("[AIMUSICAPI_DISPATCH]", JSON.stringify(dispatchPayload, null, 2));
  console.log("[EXACT_OUTBOUND_BODY]", JSON.stringify(dispatchPayload, null, 2));

  const endpoints = [MUSICAPI_CREATE_URL, AIMUSICAPI_CREATE_URL];
  let lastError: unknown = null;

  for (const endpoint of endpoints) {
    logAimusicRequest(endpoint, apiKey);
    try {
      const response = await globalThis.fetch(endpoint, {
        method: "POST",
        headers: musicApiAuthHeaders(apiKey),
        body: JSON.stringify(dispatchPayload),
        signal: mergeAbortSignals(AIMUSICAPI_FETCH_TIMEOUT_MS, abortSignal),
      });
      console.log("[MUSICAPI_DISPATCH]", { url: endpoint, status: response.status });
      const responseText = await response.clone().text();
      console.log("[AIMUSICAPI_RESPONSE_STATUS]", response.status);
      console.log("[AIMUSICAPI_RESPONSE_BODY]", responseText);
      const raw = responseText
        ? (() => {
            try {
              return JSON.parse(responseText) as unknown;
            } catch {
              return responseText;
            }
          })()
        : null;

      // Fall back only on hard host/routing failures, not auth / validation errors.
      if (
        !response.ok &&
        endpoint === MUSICAPI_CREATE_URL &&
        (response.status === 404 || response.status === 502 || response.status === 503)
      ) {
        console.warn("[MUSICAPI_DISPATCH] primary host failed — trying AIMusicAPI fallback");
        lastError = new Error(\`Primary MusicAPI create failed (\${response.status})\`);
        continue;
      }

      if (!response.ok) {
        console.error("[AIMUSICAPI_ERROR]", response.status, previewBody(raw));
      }
      return { response, raw, endpoint };
    } catch (error) {
      if (isGenerationAborted(error)) throw error;
      lastError = error;
      if (endpoint === MUSICAPI_CREATE_URL) {
        console.warn(
          "[MUSICAPI_DISPATCH] primary host unreachable — trying AIMusicAPI fallback",
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("MusicAPI create failed on all hosts");
}

`;

t = t.slice(0, postStart) + postFn + t.slice(postEnd);

// Poll URL + Content-Type header
t = t.replace(
  "const targetUrl = `${SONIC_TASK_URL}/${encodeURIComponent(taskId)}`;",
  "const targetUrl = `${MUSICAPI_TASK_URL}/${encodeURIComponent(taskId)}`;",
);
t = t.replace(
  "const targetUrl = `${SUNO_TASK_URL}/${encodeURIComponent(taskId)}`;",
  "const targetUrl = `${MUSICAPI_TASK_URL}/${encodeURIComponent(taskId)}`;",
);

// Ensure poll headers include Content-Type as requested (even for GET)
t = t.replace(
  /response = await fetch\(targetUrl, \{\n\s*method: "GET",\n\s*headers: \{\n\s*Authorization: `Bearer \$\{apiKey\}`,\n\s*\},/m,
  `response = await fetch(targetUrl, {
      method: "GET",
      headers: musicApiAuthHeaders(apiKey),`,
);

// generateStudioTrack may destructure without endpoint — keep compatible
t = t.replace(
  "const { response, raw } = await postSonicCreate(request, apiKey, abortSignal);",
  "const { response, raw } = await postSonicCreate(request, apiKey, abortSignal);",
);

fs.writeFileSync(file, t);
console.log("music-generation MusicAPI lock patched");
