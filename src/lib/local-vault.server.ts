import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { UserVaultApiTrack, UserVaultStems } from "@/lib/user-vault.server";
import { asVaultStatus } from "@/lib/user-vault.server";
import { isDevRuntime } from "@/lib/supabase-env.server";

const ROOT = join(process.cwd(), ".data", "local-vault");
const CATALOG = join(ROOT, "catalog.json");

export function localVaultEnabled(): boolean {
  return isDevRuntime();
}

function mimeFor(name: string): string {
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".flac")) return "audio/flac";
  return "audio/mpeg";
}

async function ensureRoot(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
}

export async function saveLocalAudioFile(
  bytes: Uint8Array,
  objectPath: string,
  fileType: "mp3" | "wav" | "flac" | string = "mp3",
): Promise<string> {
  await ensureRoot();
  const ext = fileType.replace(/^\./, "") || "mp3";
  const safe = objectPath.replace(/[^a-zA-Z0-9/_-]/g, "_").replace(/\//g, "__");
  const fileName = `${safe}.${ext}`;
  await writeFile(join(ROOT, fileName), bytes);
  console.warn(`[local-vault] saved ${fileName} (${bytes.byteLength} bytes)`);
  return `/api/local-vault/${encodeURIComponent(fileName)}`;
}

export async function readLocalAudioFile(
  fileName: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe !== fileName) return null;
  try {
    const bytes = await readFile(join(ROOT, safe));
    return { bytes, mimeType: mimeFor(safe) };
  } catch {
    return null;
  }
}

async function loadCatalog(): Promise<UserVaultApiTrack[]> {
  try {
    const raw = await readFile(CATALOG, "utf8");
    const parsed = JSON.parse(raw) as UserVaultApiTrack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeCatalog(rows: UserVaultApiTrack[]): Promise<void> {
  await ensureRoot();
  await writeFile(CATALOG, JSON.stringify(rows, null, 2), "utf8");
}

export async function persistLocalVaultTrack(
  userId: string,
  stems: UserVaultStems,
): Promise<string> {
  const rows = await loadCatalog();
  const id = stems.id || randomUUID();
  const next: UserVaultApiTrack = {
    id,
    title: stems.title.trim() || "Untitled Track",
    style: stems.style?.trim() || "Custom",
    status: asVaultStatus(stems.status),
    master_url: stems.masterUrl || null,
    instrumental_url: stems.instrumentalUrl || null,
    vocal_url: stems.vocalUrl || null,
    created_at: new Date().toISOString(),
  };
  const without = rows.filter((row) => row.id !== id);
  await writeCatalog([next, ...without]);
  console.warn(`[local-vault] cataloged ${id} for ${userId}`);
  return id;
}

export async function listLocalVaultTracks(): Promise<UserVaultApiTrack[]> {
  return loadCatalog();
}
