/**
 * Validation for the "Custom Voice Model URL (.zip)" field used by the
 * Hybrid Voice Conversion (RVC v2) step. Runs client-side before we spend a
 * conversion job, and returns plain-language errors an artist can act on.
 */

export const VOICE_MODEL_URL_MAX = 2000;

const ALLOWED_EXTENSIONS = [".zip", ".pth", ".index"];

export type VoiceModelUrlCheck = { ok: true; url: string } | { ok: false; message: string };

export function validateVoiceModelUrl(raw: string): VoiceModelUrlCheck {
  const value = raw.trim();

  if (!value) {
    return { ok: false, message: "Add your RVC v2 model link before converting." };
  }
  if (value.length > VOICE_MODEL_URL_MAX) {
    return { ok: false, message: `That link is too long (max ${VOICE_MODEL_URL_MAX} characters).` };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      message: "That is not a valid link. Paste the full URL, starting with https://",
    };
  }

  if (parsed.protocol === "http:") {
    return { ok: false, message: "Use an https:// link — http links are blocked for security." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, message: "Only https:// links are supported for voice models." };
  }
  if (!parsed.hostname.includes(".") || /^localhost$/i.test(parsed.hostname)) {
    return { ok: false, message: "That link points to a local address we cannot download from." };
  }

  const path = parsed.pathname.toLowerCase();
  const hasExtension = ALLOWED_EXTENSIONS.some((ext) => path.endsWith(ext));
  if (!hasExtension) {
    if (/\/(tree|blob)\//.test(path) || path.endsWith("/")) {
      return {
        ok: false,
        message:
          "That looks like a page, not a file. Open the model page, copy the direct download link ending in .zip",
      };
    }
    return {
      ok: false,
      message: "The link must point straight at your model file (.zip, .pth or .index).",
    };
  }

  return { ok: true, url: value };
}
