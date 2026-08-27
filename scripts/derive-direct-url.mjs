/**
 * Derive a true Supabase DIRECT_URL (db.<ref>.supabase.co:5432) from
 * DATABASE_URL + NEXT_PUBLIC_SUPABASE_URL and write it into .env.local
 * without printing secrets.
 *
 * Usage: bun scripts/derive-direct-url.mjs
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

config({ path: ".env.local" });
config({ path: ".env" });

function stripQuotes(raw) {
  let s = String(raw ?? "").trim();
  while (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function projectRefFromSupabaseUrl(url) {
  try {
    const host = new URL(stripQuotes(url)).hostname; // xxx.supabase.co
    const m = host.match(/^([a-z0-9-]+)\.supabase\.co$/i);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function projectRefFromPoolerUser(username) {
  // postgres.<project-ref>
  const m = String(username || "").match(/^postgres\.([a-z0-9]+)$/i);
  return m?.[1] ?? null;
}

const databaseUrl = stripQuotes(process.env.DATABASE_URL);
const supabasePublic = stripQuotes(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
);

if (!databaseUrl) {
  console.error("[derive-direct-url] DATABASE_URL is missing.");
  process.exit(1);
}

let pooled;
try {
  pooled = new URL(databaseUrl);
} catch {
  console.error("[derive-direct-url] DATABASE_URL is not a valid URL.");
  process.exit(1);
}

const ref =
  projectRefFromSupabaseUrl(supabasePublic) ||
  projectRefFromPoolerUser(pooled.username);

if (!ref) {
  console.error(
    "[derive-direct-url] Could not resolve project ref from NEXT_PUBLIC_SUPABASE_URL or pooler username.",
  );
  process.exit(1);
}

const password = decodeURIComponent(pooled.password || "");
if (!password) {
  console.error("[derive-direct-url] DATABASE_URL has no password to reuse.");
  process.exit(1);
}

const direct = new URL("postgresql://placeholder");
direct.protocol = "postgresql:";
direct.username = "postgres";
direct.password = password;
direct.hostname = `db.${ref}.supabase.co`;
direct.port = "5432";
direct.pathname = pooled.pathname || "/postgres";
direct.search = "sslmode=require";

const directHref = direct.toString();
const envPath = resolve(process.cwd(), ".env.local");
let existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

if (/^DIRECT_URL=/m.test(existing)) {
  existing = existing.replace(/^DIRECT_URL=.*$/m, `DIRECT_URL="${directHref}"`);
} else {
  const block = `\n# Prisma CLI / migrate (direct Postgres — not the pooler)\nDIRECT_URL="${directHref}"\n`;
  existing = existing.trimEnd() + block;
}

writeFileSync(envPath, existing.endsWith("\n") ? existing : `${existing}\n`, "utf8");

console.log("[derive-direct-url] Wrote DIRECT_URL to .env.local");
console.log(`[derive-direct-url] host=db.${ref}.supabase.co port=5432 user=postgres`);
console.log(
  "[derive-direct-url] DATABASE_URL left unchanged (keep pooled :6543 for runtime).",
);
console.log("[derive-direct-url] Next: bunx prisma db push");
