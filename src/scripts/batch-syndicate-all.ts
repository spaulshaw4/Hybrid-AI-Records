/**
 * One-time IndexNow batch for the live Hybrid AI Records site.
 *
 *   npm run syndicate:all
 *
 * Env (from the process, .env.local, or .env):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   INDEXNOW_API_KEY          optional; a public fallback is used when unset
 *
 * Loads `id, title, artist` from Supabase table `Track`. If that table or
 * those columns fail, falls back to catalog table `artist_tracks`
 * (`id, title, artist_name`) and names that table in the log. Missing env
 * or a failed query still submits the static URL list. Never prints secrets.
 *
 * Does not submit `/catalog/[slug]` or `/track/[slug]`. Those routes are
 * not the live site.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const HOST = "hybrid-ai-records.com";
const ORIGIN = `https://${HOST}`;
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const FALLBACK_INDEXNOW_KEY = "8f4b6a9c1e7d23508a1c9e4b7d6f5a32";
const CATALOG_TABLE = "artist_tracks";
const PAGE_SIZE = 1000;

/**
 * Required live URLs, plus public pages already shipped in src/routes.
 * Portal aliases come from resolvePortalTab / SITE_NAV. Pricing URLs are
 * /plans, /tokens, /v-tokens, /start/foundation, and the order-form packages.
 * Admin, auth callbacks, and private APIs are omitted.
 */
const STATIC_URLS = [
  `${ORIGIN}/`,
  `${ORIGIN}/portal?tab=create`,
  `${ORIGIN}/portal?tab=catalog`,
  `${ORIGIN}/portal?tab=plans`,
  `${ORIGIN}/portal?tab=radio`,
  `${ORIGIN}/portal?tab=distro`,
  `${ORIGIN}/api/feed/mrss.xml`,
  `${ORIGIN}/portal`,
  `${ORIGIN}/portal?tab=distribution`,
  `${ORIGIN}/portal?tab=catalog_merch`,
  `${ORIGIN}/portal?tab=video`,
  `${ORIGIN}/portal?tab=merch`,
  `${ORIGIN}/plans`,
  `${ORIGIN}/engine`,
  `${ORIGIN}/studio`,
  `${ORIGIN}/simple-studio`,
  `${ORIGIN}/cinematic-studio`,
  `${ORIGIN}/artists`,
  `${ORIGIN}/tokens`,
  `${ORIGIN}/v-tokens`,
  `${ORIGIN}/prompts`,
  `${ORIGIN}/licensing`,
  `${ORIGIN}/privacy`,
  `${ORIGIN}/start`,
  `${ORIGIN}/start/onboarding`,
  `${ORIGIN}/start/foundation`,
  `${ORIGIN}/veteran-certification`,
  `${ORIGIN}/portal?package=distribution-release`,
  `${ORIGIN}/portal?package=visual-push`,
  `${ORIGIN}/portal?package=full-label`,
  `${ORIGIN}/portal?package=standard-video`,
  `${ORIGIN}/portal?package=4k-hd-video`,
];

type IdRow = { id?: unknown };

function normalize(raw: string | undefined): string {
  let value = (raw ?? "").trim();
  while (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function redact(message: string, secret: string): string {
  if (!secret || !message.includes(secret)) return message;
  return message.split(secret).join("[redacted]");
}

function indexNowKey(): string {
  return normalize(process.env.INDEXNOW_API_KEY) || FALLBACK_INDEXNOW_KEY;
}

function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9-]{8,128}$/.test(key);
}

function trackUrl(id: string): string {
  return `${ORIGIN}/portal?tab=catalog&track=${encodeURIComponent(id)}`;
}

function rowId(row: IdRow): string | null {
  if (typeof row.id === "string" && row.id.trim()) return row.id.trim();
  if (typeof row.id === "number" && Number.isFinite(row.id)) return String(row.id);
  return null;
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

async function selectIds(
  supabase: SupabaseClient,
  table: string,
  columns: string,
): Promise<{ ids: string[]; error: string | null }> {
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { ids: [], error: error.message };
    const page = (data ?? []) as IdRow[];
    for (const row of page) {
      const id = rowId(row);
      if (id) ids.push(id);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return { ids, error: null };
}

async function loadTrackIds(serviceKey: string): Promise<{
  ids: string[];
  table: string | null;
  note: string;
}> {
  const missing: string[] = [];
  if (!normalize(process.env.NEXT_PUBLIC_SUPABASE_URL)) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) {
    return {
      ids: [],
      table: null,
      note: `skipped; missing ${missing.join(", ")}`,
    };
  }

  const supabaseUrl = normalize(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const primary = await selectIds(supabase, "Track", "id, title, artist");
  if (!primary.error) {
    return {
      ids: primary.ids,
      table: "Track",
      note: `loaded ${primary.ids.length} row(s) from Track`,
    };
  }

  const primaryError = redact(primary.error, serviceKey);
  const catalog = await selectIds(supabase, CATALOG_TABLE, "id, title, artist_name");
  if (!catalog.error) {
    return {
      ids: catalog.ids,
      table: CATALOG_TABLE,
      note: `Track failed (${primaryError}); loaded ${catalog.ids.length} row(s) from ${CATALOG_TABLE}`,
    };
  }

  return {
    ids: [],
    table: null,
    note: `Track failed (${primaryError}); ${CATALOG_TABLE} failed (${redact(catalog.error, serviceKey)})`,
  };
}

async function readPublicKey(
  key: string,
): Promise<{ status: number; reachable: boolean; note: string }> {
  const keyUrl = `${ORIGIN}/${key}.txt`;
  try {
    const response = await fetch(keyUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: "text/plain" },
    });
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const html = /text\/html/i.test(contentType) || /^\s*</.test(body);
    const reachable = response.status === 200 && !html && body.trim() === key;
    return {
      status: response.status,
      reachable,
      note: reachable
        ? "public key file matches"
        : `not a public key file (HTTP ${response.status})`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return { status: 0, reachable: false, note: message };
  }
}

async function main(): Promise<void> {
  const key = indexNowKey();
  const serviceKey = normalize(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const keyFile = await readPublicKey(key);
  let wroteKeyFile: string | null = null;

  if (!keyFile.reachable) {
    if (!isSafeKey(key)) {
      console.log("keyFile.wrote=skipped");
      console.log("keyFile.writeNote=INDEXNOW_API_KEY is not a safe public filename");
    } else {
      const relative = path.join("public", `${key}.txt`);
      const absolute = path.join(process.cwd(), relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, key, { encoding: "utf8" });
      wroteKeyFile = relative;
    }
  }

  const tracks = await loadTrackIds(serviceKey);
  const urlList = uniqueUrls([...STATIC_URLS, ...tracks.ids.map(trackUrl)]);

  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: HOST,
      key,
      keyLocation: `${ORIGIN}/${key}.txt`,
      urlList,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await response.text();

  console.log(`keyFile.url=${ORIGIN}/${key}.txt`);
  console.log(`keyFile.httpStatus=${keyFile.status}`);
  console.log(`keyFile.reachable=${keyFile.reachable}`);
  console.log(`keyFile.note=${keyFile.note}`);
  console.log(`keyFile.wrote=${wroteKeyFile ?? "no"}`);
  console.log(`tracks.included=${tracks.ids.length > 0}`);
  console.log(`tracks.count=${tracks.ids.length}`);
  console.log(`tracks.table=${tracks.table ?? "none"}`);
  console.log(`tracks.note=${tracks.note}`);
  console.log(`urlCount=${urlList.length}`);
  console.log(`indexNow.httpStatus=${response.status}`);
  console.log("indexNow.body<<EOF");
  console.log(responseBody);
  console.log("EOF");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "IndexNow batch failed";
  const serviceKey = normalize(process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.error(redact(message, serviceKey));
  process.exitCode = 1;
});
