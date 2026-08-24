/**
 * Create/repair public.voice_profiles + RLS, then reload PostgREST schema cache.
 * Usage: node scripts/ensure-voice-profiles.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
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
  v = v.replace(/^\uFEFF/, "");
  if (!v) return "";
  if (!/^postgres(ql)?:\/\//i.test(v)) return "";
  // Drop sslmode from the URL — pg v8+ treats require as verify-full and
  // rejects Supabase's chain. We pass ssl.rejectUnauthorized:false below.
  return v
    .replace(/([?&])sslmode=[^&]*/gi, "$1")
    .replace(/\?&/, "?")
    .replace(/[?&]$/, "");
}

const connectionString =
  normalize(process.env.DIRECT_URL) || normalize(process.env.DATABASE_URL);

if (!connectionString) {
  console.error("Missing DIRECT_URL or DATABASE_URL");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = resolve(
  __dirname,
  "../supabase/migrations/20260824140000_ensure_voice_profiles.sql",
);
const sql = readFileSync(sqlPath, "utf8");

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  await client.query(sql);
  const { rows } = await client.query(
    `SELECT to_regclass('public.voice_profiles') AS reg,
            (SELECT count(*)::int FROM public.voice_profiles) AS row_count`,
  );
  console.log("voice_profiles ready:", rows[0]);
} catch (error) {
  console.error("ensure-voice-profiles failed:", error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
