/**
 * Private local audio harvest into `.ingest_vault` (gitignored).
 *
 * Usage:
 *   npm run harvest:audio
 *   npm run harvest:audio -- --dry-run
 *   npm run harvest:audio -- --limit 3
 *   npm run harvest:audio -- https://archive.org/download/ID/file.mp3
 *
 * With no URLs on the command line, the queue is built from scraped-output.md.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

const VAULT_DIR = resolve(process.cwd(), ".ingest_vault");
const SCRAPE_FILE = resolve(process.cwd(), "scraped-output.md");
const AUDIO_EXT = new Set([".mp3", ".ogg", ".oga", ".flac", ".wav", ".m4a", ".aiff", ".aif"]);
const SKIP_IDENTIFIERS = new Set(["netlabels", "audio", "opensource_audio"]);
const USER_AGENT = "HybridAIForge-local-harvest/1.0";

if (!existsSync(VAULT_DIR)) {
  mkdirSync(VAULT_DIR, { recursive: true });
}

type QueueItem = { url: string; filename: string };

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, "_").slice(0, 180);
}

function isAudioUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return AUDIO_EXT.has(extname(path.split("?")[0] ?? path));
  } catch {
    return false;
  }
}

function extractMarkdownUrls(markdown: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g,
    /(?<!\()(https?:\/\/[^\s)<>"]+)/g,
  ];
  for (const re of patterns) {
    for (const match of markdown.matchAll(re)) {
      const raw = (match[1] ?? match[0]).replace(/[.,;]+$/, "");
      try {
        found.add(new URL(raw).toString());
      } catch {
        /* skip malformed */
      }
    }
  }
  return [...found];
}

function identifierFromDetailsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("archive.org")) return null;
    const match = parsed.pathname.match(/^\/details\/([^/]+)/);
    const id = match?.[1];
    if (!id || SKIP_IDENTIFIERS.has(id)) return null;
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}

async function fetchJson(url: string, retries = 4): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(`${url} → ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      const wait = 1500 * 2 ** attempt;
      console.warn(`Retry ${attempt + 1}/${retries} after ${wait}ms: ${url}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

function preferredAudioFile(
  identifier: string,
  files: Array<{ name?: string; format?: string }>,
): QueueItem | null {
  const ranked = files
    .filter((file) => file.name && AUDIO_EXT.has(extname(file.name).toLowerCase()))
    .sort((a, b) => {
      const score = (format: string | undefined) => {
        const f = (format ?? "").toLowerCase();
        if (f.includes("vbr mp3")) return 0;
        if (f === "mp3" || f.includes("128kbps")) return 1;
        if (f.includes("ogg")) return 2;
        if (f.includes("flac")) return 3;
        return 4;
      };
      return score(a.format) - score(b.format);
    });
  const pick = ranked[0];
  if (!pick?.name) return null;
  return {
    url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(pick.name)}`,
    filename: sanitizeFilename(`${identifier}__${basename(pick.name)}`),
  };
}

async function resolveArchiveIdentifier(
  identifier: string,
  remaining: number,
  depth = 0,
): Promise<QueueItem[]> {
  if (remaining <= 0 || depth > 2) return [];

  const meta = (await fetchJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`)) as {
    metadata?: { mediatype?: string };
    files?: Array<{ name?: string; format?: string }>;
  };
  const mediatype = meta.metadata?.mediatype ?? "";

  if (mediatype === "collection") {
    const pageSize = 100;
    const items: QueueItem[] = [];
    let page = 1;
    while (items.length < remaining) {
      const search = (await fetchJson(
        `https://archive.org/advancedsearch.php?q=collection:(${encodeURIComponent(identifier)})+AND+mediatype:(audio)&fl[]=identifier&sort[]=downloads+desc&rows=${pageSize}&page=${page}&output=json`,
      )) as { response?: { docs?: Array<{ identifier?: string }>; numFound?: number } };
      const docs = search.response?.docs ?? [];
      if (docs.length === 0) break;
      for (const doc of docs) {
        if (items.length >= remaining) break;
        const child = doc.identifier;
        if (!child || child === identifier) continue;
        const nested = await resolveArchiveIdentifier(child, remaining - items.length, depth + 1);
        items.push(...nested);
      }
      if (docs.length < pageSize) break;
      if ((search.response?.numFound ?? 0) <= page * pageSize) break;
      page += 1;
    }
    return items;
  }

  const file = preferredAudioFile(identifier, meta.files ?? []);
  return file ? [file] : [];
}

async function queueFromMarkdown(markdown: string, limit: number): Promise<QueueItem[]> {
  const urls = extractMarkdownUrls(markdown);
  const queue: QueueItem[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    if (queue.length >= limit) break;
    if (isAudioUrl(url)) {
      if (seen.has(url)) continue;
      seen.add(url);
      queue.push({ url, filename: sanitizeFilename(basename(new URL(url).pathname) || "track.mp3") });
      continue;
    }
    const identifier = identifierFromDetailsUrl(url);
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    try {
      const resolved = await resolveArchiveIdentifier(identifier, limit - queue.length);
      for (const item of resolved) {
        if (queue.length >= limit) break;
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        queue.push(item);
      }
      if (resolved.length > 0) {
        console.log(`Queued ${queue.length}/${limit} (last source: ${identifier})`);
      }
    } catch (error) {
      console.error(`Skip ${identifier}:`, error);
    }
  }

  return queue;
}

async function downloadTrack(audioUrl: string, filename: string) {
  const destination = resolve(VAULT_DIR, filename);
  if (existsSync(destination)) {
    console.log(`Skipping: ${filename} (already saved)`);
    return;
  }
  console.log(`Pulling: ${filename}...`);
  try {
    const response = await fetch(audioUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch ${audioUrl} - Status: ${response.status}`);
    }
    const fileStream = createWriteStream(destination);
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), fileStream);
    console.log(`Secured in vault: ${filename}`);
  } catch (error) {
    console.error(`Error downloading ${filename}:`, error);
  }
}

async function run() {
  const dryRun = hasFlag("--dry-run");
  const limit = Math.max(1, Number(argValue("--limit") || 5));
  const cliUrls = process.argv.slice(2).filter((arg) => arg.startsWith("http"));

  let downloadQueue: QueueItem[] = cliUrls.map((url, i) => ({
    url,
    filename: sanitizeFilename(basename(new URL(url).pathname) || `source_sample_${String(i + 1).padStart(2, "0")}.mp3`),
  }));

  if (downloadQueue.length === 0 && existsSync(SCRAPE_FILE)) {
    console.log(`Scanning ${basename(SCRAPE_FILE)} for audio URLs (limit ${limit})...`);
    downloadQueue = await queueFromMarkdown(readFileSync(SCRAPE_FILE, "utf8"), limit);
  }

  if (downloadQueue.length === 0) {
    downloadQueue = [
      {
        url: "https://archive.org/download/SAMPLE_ID/SAMPLE_FILE.mp3",
        filename: "source_sample_01.mp3",
      },
    ];
    console.log("No scrape URLs found. Using placeholder queue — pass a real audio URL or scrape a track page first.");
  }

  if (dryRun) {
    for (const item of downloadQueue) {
      console.log(`${item.filename}\n  ${item.url}`);
    }
    console.log(`Dry run: ${downloadQueue.length} item(s), nothing downloaded.`);
    return;
  }

  for (const item of downloadQueue) {
    await downloadTrack(item.url, item.filename);
  }
  console.log(`Ingestion complete. Assets stored in private vault: ${VAULT_DIR}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
