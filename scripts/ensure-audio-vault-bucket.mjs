/**
 * List Supabase Storage buckets and ensure audio-vault exists (public for CDN).
 * Usage: node scripts/ensure-audio-vault-bucket.mjs
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
const BUCKET = normalize(process.env.AUDIO_VAULT_BUCKET) || "audio-vault";

if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: existing, error: listError } = await admin.storage.listBuckets();
if (listError) {
  console.error("listBuckets failed:", listError.message);
  process.exit(1);
}

console.log(
  "Buckets:",
  (existing ?? []).map((b) => ({ id: b.id, name: b.name, public: b.public })),
);

const found = (existing ?? []).find((b) => b.id === BUCKET || b.name === BUCKET);
if (found) {
  console.log(`Bucket "${BUCKET}" already exists (public=${found.public}).`);
  if (!found.public) {
    const { error } = await admin.storage.updateBucket(BUCKET, { public: true });
    if (error) console.error("updateBucket public=true failed:", error.message);
    else console.log(`Updated "${BUCKET}" to public=true for Gate 2 CDN URLs.`);
  }
} else {
  const { data, error } = await admin.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 104857600,
    allowedMimeTypes: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4"],
  });
  if (error) {
    console.error("createBucket failed:", error.message);
    process.exit(1);
  }
  console.log(`Created bucket "${BUCKET}" (public).`, data ?? "");
}
