/**
 * Batch-upload local masters into Supabase `audio-vault` and index `user_vault`.
 *
 * Usage:
 *   npm run upload:vault -- ./path/to/audio
 *   AUDIO_DIR=./masters npm run upload:vault
 *
 * Env (from .env / .env.local):
 *   SUPABASE_URL | VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   AUDIO_VAULT_BUCKET          (default: audio-vault)
 *   VAULT_OWNER_USER_ID         (optional auth.users uuid)
 *   VAULT_ARTIST_NAME           (default: Hybrid AI Records)
 *   VAULT_ALBUM_NAME            (default: Singles)
 *   VAULT_WIPE_FIRST=1          (optional — wipe user_vault first)
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, parse, resolve } from "node:path";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

function normalize(raw: string | undefined): string {
  let v = (raw ?? "").trim();
  while (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function titleFromFilename(file: string): string {
  return parse(file)
    .name.replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAudioFile(name: string): boolean {
  return /\.(mp3|wav)$/i.test(name);
}

async function main(): Promise<void> {
  const supabaseUrl =
    normalize(process.env.SUPABASE_URL) ||
    normalize(process.env.NEXT_PUBLIC_SUPABASE_URL) ||
    normalize(process.env.VITE_SUPABASE_URL);
  const supabaseKey = normalize(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const bucket = normalize(process.env.AUDIO_VAULT_BUCKET) || "audio-vault";
  const artistName = normalize(process.env.VAULT_ARTIST_NAME) || "Hybrid AI Records";
  const albumName = normalize(process.env.VAULT_ALBUM_NAME) || "Singles";
  const ownerUserId = normalize(process.env.VAULT_OWNER_USER_ID) || null;
  const wipeFirst = ["1", "true", "yes", "on"].includes(
    normalize(process.env.VAULT_WIPE_FIRST).toLowerCase(),
  );

  const audioDir = resolve(
    process.argv[2] || normalize(process.env.AUDIO_DIR) || "./audio-masters-folder",
  );

  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  if (!existsSync(audioDir) || !statSync(audioDir).isDirectory()) {
    console.error(`Audio directory not found: ${audioDir}`);
    console.error("Usage: npm run upload:vault -- ./path/to/mp3s");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (wipeFirst) {
    console.log("VAULT_WIPE_FIRST=1 — deleting all user_vault rows…");
    const { error } = await supabase
      .from("user_vault")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) {
      console.error("Wipe failed:", error.message);
      process.exit(1);
    }
    console.log("user_vault cleared.");
  }

  const files = readdirSync(audioDir).filter(isAudioFile);
  console.log(`Found ${files.length} audio track(s) in ${audioDir}`);
  if (files.length === 0) {
    process.exit(0);
  }

  let ok = 0;
  for (const file of files) {
    const filePath = join(audioDir, file);
    const fileBuffer = readFileSync(filePath);
    const ext = file.toLowerCase().endsWith(".wav") ? "wav" : "mp3";
    const safeName = file.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `mastered/${Date.now()}_${randomUUID().slice(0, 8)}_${safeName}`;
    const contentType = ext === "wav" ? "audio/wav" : "audio/mpeg";

    console.log(`Uploading: ${file} → ${bucket}/${storagePath}`);
    const { error: uploadError } = await supabase.storage.from(bucket).upload(storagePath, fileBuffer, {
      contentType,
      upsert: true,
    });
    if (uploadError) {
      console.error(`  Upload failed: ${uploadError.message}`);
      continue;
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(bucket).getPublicUrl(storagePath);

    if (!publicUrl || !/^https?:\/\//i.test(publicUrl)) {
      console.error(`  Invalid public CDN URL for ${file}: ${publicUrl}`);
      continue;
    }

    const trackTitle = titleFromFilename(file);
    const row: Record<string, string> = {
      title: trackTitle,
      style: albumName,
      status: "completed",
      master_url: publicUrl,
      artist_name: artistName,
      album_name: albumName,
      created_at: new Date().toISOString(),
    };
    if (ownerUserId) row.user_id = ownerUserId;

    const { error: dbError } = await supabase.from("user_vault").insert(row);
    if (dbError) {
      console.error(`  DB insert failed: ${dbError.message}`);
      continue;
    }

    ok += 1;
    console.log(`  Indexed: ${trackTitle}`);
    console.log(`  CDN: ${publicUrl.slice(0, 96)}`);
  }

  console.log(`Catalog upload complete — ${ok}/${files.length} indexed.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
