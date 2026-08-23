import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/music-generation.ts");
let text = fs.readFileSync(file, "utf8");

const startMarkers = ["function genderNegativeTags", "function genderNegativeTags"];
const start =
  text.indexOf("function genderNegativeTags") >= 0
    ? text.indexOf("function genderNegativeTags")
    : text.indexOf("function genderNegativeTags".replace("genderNegative", "genderNegative"));
const realStart = ["function genderNegativeTags", "function genderNegativeTags"].map((m) => text.indexOf(m)).find((i) => i >= 0);
const startIdx = Math.max(
  text.indexOf("function genderNegativeTags"),
  text.indexOf("function genderNegativeTags"),
);
void startMarkers;
void start;
void realStart;

let startAt = text.indexOf("function genderNegativeTags");
if (startAt < 0) startAt = text.indexOf("function genderNegativeTags");
if (startAt < 0) {
  // actual name in file
  startAt = text.indexOf("function genderNegativeTags");
}
startAt = text.indexOf("function genderNegativeTags");
if (startAt < 0) startAt = text.indexOf("function genderNegativeTags");
startAt = text.search(/function genderNegativeTags|function genderNegativeTags|function genderNegativeTags/);

// Find the real function name used in the source
const match = text.match(/function gender\w+Tags\(/);
if (!match) {
  console.error("could not find gender*Tags function");
  process.exit(1);
}
startAt = text.indexOf(match[0]);
const endAt = text.indexOf("export async function generateStudioTrack");
if (startAt < 0 || endAt < 0) {
  console.error("markers missing", { startAt, endAt, found: match?.[0] });
  process.exit(1);
}

const lines = [
  "function genderNegativeTags(_gender: SonicVocalGender | undefined): string | undefined {",
  "  return undefined;",
  "}",
  "",
  "/** Drop undefined / null optional keys before the Suno POST. */",
  "export function cleanSonicPayload<T extends Record<string, unknown>>(payload: T): T {",
  "  return Object.fromEntries(",
  '    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ""),',
  "  ) as T;",
  "}",
  "",
  "function appendGenderTag(tags: string, gender: SonicVocalGender): string {",
  '  const phrase = gender === "m" ? "male vocals" : "female vocals";',
  "  if (tags.toLowerCase().includes(phrase)) return tags;",
  "  return tags ? `${tags}, ${phrase}` : phrase;",
  "}",
  "",
  "/** Strict Suno v5 create body per AIMusicAPI docs — caller `mv` is ignored. */",
  "export function buildSonicCreatePayload(options: StudioTrackOptions): SonicCreatePayload {",
  "  const gender = normalizeVocalGender(options.vocal_gender || options.vocalGender);",
  '  let tags = options.tags?.trim() || styleTags(options) || options.genre || "";',
  "  if (gender) tags = appendGenderTag(tags, gender);",
  "",
  "  const payload: SonicCreatePayload = {",
  '    task_type: "create_music",',
  "    custom_mode: true,",
  "    mv: SUNO_MODEL,",
  '    prompt: options.lyrics ?? "",',
  "    tags,",
  '    title: options.title || "Studio Master",',
  "  };",
  "",
  "  if (gender) {",
  "    payload.vocal_gender = gender;",
  "  } else {",
  "    delete payload.vocal_gender;",
  "  }",
  "",
  "  return cleanSonicPayload(payload);",
  "}",
  "",
  "function previewBody(raw: unknown): string {",
  '  if (raw == null) return "";',
  '  if (typeof raw === "string") return raw;',
  "  try {",
  "    return JSON.stringify(raw, null, 2);",
  "  } catch {",
  "    return String(raw);",
  "  }",
  "}",
  "",
  "async function readResponseBody(response: Response): Promise<unknown> {",
  "  const text = await response.text();",
  "  if (!text) return null;",
  "  try {",
  "    return JSON.parse(text) as unknown;",
  "  } catch {",
  "    return text;",
  "  }",
  "}",
  "",
  "/** True when MusicAPI rejected the model version (not auth / network). */",
  "export function isInvalidMvRejection(status: number, raw: unknown): boolean {",
  "  if (status === 401 || status === 403) return false;",
  "  if (status < 400) return false;",
  "  const text = previewBody(raw).toLowerCase();",
  "  return (",
  "    status === 400 ||",
  "    status === 422 ||",
  '    text.includes("mv field is invalid") ||',
  '    text.includes("invalid model")',
  "  );",
  "}",
  "",
  "async function postSonicCreate(",
  "  payload: SonicCreatePayload,",
  "  apiKey: string,",
  "  abortSignal?: AbortSignal,",
  "): Promise<{ response: Response; raw: unknown }> {",
  "  const lyricsPrompt = payload.prompt;",
  "  const styleTagsValue = payload.tags;",
  "  const trackTitle = payload.title;",
  "  const vocalGender = normalizeVocalGender(payload.vocal_gender);",
  "",
  "  // Exact AIMusicAPI Suno v5 create body (docs). Native fetch only — no Lovable proxies.",
  "  const dispatchPayload: Record<string, unknown> = {",
  '    task_type: "create_music",',
  "    custom_mode: true,",
  '    mv: "chirp-v5",',
  "    prompt: lyricsPrompt,",
  "    tags: styleTagsValue,",
  "    title: trackTitle,",
  "    ...(vocalGender ? { vocal_gender: vocalGender } : {}),",
  "  };",
  "",
  '  console.log("[AIMUSICAPI_DISPATCH]", JSON.stringify(dispatchPayload, null, 2));',
  '  console.log("[EXACT_OUTBOUND_BODY]", JSON.stringify(dispatchPayload, null, 2));',
  '  console.log("[DIRECT_PAYLOAD_DISPATCH]", JSON.stringify(dispatchPayload, null, 2));',
  "  logAimusicRequest(SUNO_CREATE_URL, apiKey);",
  "",
  "  const response = await globalThis.fetch(SUNO_CREATE_URL, {",
  '    method: "POST",',
  "    headers: {",
  "      Authorization: `Bearer ${apiKey}`,",
  '      "Content-Type": "application/json",',
  '      Accept: "application/json",',
  "    },",
  "    body: JSON.stringify(dispatchPayload),",
  "    signal: mergeAbortSignals(AIMUSICAPI_FETCH_TIMEOUT_MS, abortSignal),",
  "  });",
  "  const responseText = await response.clone().text();",
  '  console.log("[AIMUSICAPI_RESPONSE_STATUS]", response.status);',
  '  console.log("[AIMUSICAPI_RESPONSE_BODY]", responseText);',
  "  const raw = responseText",
  "    ? (() => {",
  "        try {",
  "          return JSON.parse(responseText) as unknown;",
  "        } catch {",
  "          return responseText;",
  "        }",
  "      })()",
  "    : null;",
  '  console.log("[MUSICAPI_CREATE_RESPONSE]", response.status, previewBody(raw));',
  "  if (!response.ok) {",
  '    console.error("[AIMUSICAPI_ERROR]", response.status, previewBody(raw));',
  "  }",
  "  return { response, raw };",
  "}",
  "",
  "",
];

text = text.slice(0, startAt) + lines.join("\n") + text.slice(endAt);
text = text.replaceAll("${SONIC_TASK_URL}/", "${SUNO_TASK_URL}/");
text = text.replaceAll("logAimusicRequest(SONIC_CREATE_URL", "logAimusicRequest(SUNO_CREATE_URL");
text = text.replaceAll("globalThis.fetch(SONIC_CREATE_URL", "globalThis.fetch(SUNO_CREATE_URL");
text = text.replaceAll("fetch(SONIC_CREATE_URL", "fetch(SUNO_CREATE_URL");

fs.writeFileSync(file, text);
console.log("patched ok from", match[0], "at", startAt);
