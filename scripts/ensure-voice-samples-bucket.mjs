/**
 * Ensure the private `voice-samples` Storage bucket exists (service role).
 * Usage: node scripts/ensure-voice-samples-bucket.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

function normalize(raw) {
  let v = (raw ?? "").trim();
  while (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

const url =
  normalize(process.env.SUPABASE_URL) ||
  normalize(process.env.NEXT_PUBLIC_SUPABASE_URL) ||
  normalize(process.env.VITE_SUPABASE_URL);
const serviceKey = normalize(process.env.SUPABASE_SERVICE_ROLE_KEY);

if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BUCKET = "voice-samples";

const { data: existing, error: listError } = await admin.storage.listBuckets();
if (listError) {
  console.error("listBuckets failed:", listError.message);
  process.exit(1);
}

const found = (existing ?? []).find((b) => b.id === BUCKET || b.name === BUCKET);
if (found) {
  console.log(`Bucket "${BUCKET}" already exists (public=${found.public}).`);
} else {
  const { data, error } = await admin.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 26214400,
    allowedMimeTypes: [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/webm",
      "audio/mp4",
      "audio/m4a",
      "audio/x-m4a",
    ],
  });
  if (error) {
    console.error("createBucket failed:", error.message);
    process.exit(1);
  }
  console.log(`Created bucket "${BUCKET}".`, data ?? "");
}

console.log(
  "Next: apply RLS via supabase/migrations/20260824130000_ensure_voice_samples_bucket.sql if policies are missing.",
);
