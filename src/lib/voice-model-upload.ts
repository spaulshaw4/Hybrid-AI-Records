/**
 * Uploads a trained RVC v2 model file to the private "voice-models" bucket and
 * hands back a signed https URL the converter can download from. Artists who
 * don't host their model anywhere can use this instead of pasting a link.
 */
import { supabase } from "@/integrations/supabase/client";

export const VOICE_MODEL_BUCKET = "voice-models";
export const VOICE_MODEL_MAX_BYTES = 300 * 1024 * 1024; // 300 MB
export const VOICE_MODEL_ACCEPT = ".zip,.pth,.index";
const ALLOWED_EXTENSIONS = [".zip", ".pth", ".index"];
/** Long enough for the conversion job to finish downloading the model. */
const SIGNED_URL_SECONDS = 60 * 60 * 6;

export type VoiceModelUploadResult = { ok: true; url: string; name: string } | { ok: false; message: string };

function extensionOf(name: string) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "model.zip";
}

export async function uploadVoiceModel(file: File): Promise<VoiceModelUploadResult> {
  const ext = extensionOf(file.name);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      message: "That file type isn't supported. Upload your RVC v2 model as .zip (or .pth / .index).",
    };
  }
  if (file.size === 0) {
    return { ok: false, message: "That file is empty — export your model again and retry." };
  }
  if (file.size > VOICE_MODEL_MAX_BYTES) {
    return { ok: false, message: "That file is over 300 MB. Zip only the .pth and .index files." };
  }

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) {
    return { ok: false, message: "Sign in before uploading a voice model." };
  }

  const path = `${userId}/${Date.now()}-${safeName(file.name)}`;
  const { error } = await supabase.storage
    .from(VOICE_MODEL_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type || "application/zip" });

  if (error) {
    return {
      ok: false,
      message: "Upload failed. Check your connection and try that file again — nothing was saved.",
    };
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(VOICE_MODEL_BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS);

  if (signError || !signed?.signedUrl) {
    return { ok: false, message: "Uploaded, but we couldn't create a download link. Try again." };
  }

  const url = signed.signedUrl.startsWith("http")
    ? signed.signedUrl
    : new URL(signed.signedUrl, window.location.origin).toString();

  return { ok: true, url, name: file.name };
}
