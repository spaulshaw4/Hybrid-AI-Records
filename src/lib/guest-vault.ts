/**
 * Guest / unauthenticated vault persistence.
 *
 * Tracks generated without a signed-in account are stored in IndexedDB
 * (localStorage fallback), keyed to a stable device id so they survive
 * refreshes and route changes until claimed into the cloud vault on sign-in.
 */

import type { VaultTrackPayload } from "@/lib/vault-client";

const DEVICE_ID_KEY = "hybrid.vault.deviceId";
const LS_TRACKS_KEY = "hybrid.guest.vault.tracks";
const DB_NAME = "hybrid-guest-vault";
const STORE = "tracks";
const DB_VERSION = 1;
const MAX_GUEST_TRACKS = 40;

export type GuestVaultTrack = {
  id: string;
  deviceId: string;
  title: string;
  style: string;
  status: "processing" | "completed" | "failed";
  masterUrl: string | null;
  instrumentalUrl: string | null;
  vocalUrl: string | null;
  rawAudioUrl: string | null;
  tokensUsed: number;
  createdAt: string;
  artistName: string;
  albumName: string;
};

function supportedIdb(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `guest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Stable anonymous device/session id for this browser profile. */
export function getOrCreateVaultDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = newId();
    window.localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return newId();
  }
}

export function isGuestVaultId(id: string): boolean {
  return id.startsWith("guest-") || (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) && id.length > 0);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readLocalStorageTracks(): GuestVaultTrack[] {
  try {
    const raw = window.localStorage.getItem(LS_TRACKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GuestVaultTrack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalStorageTracks(tracks: GuestVaultTrack[]): void {
  try {
    window.localStorage.setItem(LS_TRACKS_KEY, JSON.stringify(tracks.slice(0, MAX_GUEST_TRACKS)));
  } catch {
    /* private mode / quota */
  }
}

async function readIdbTracks(): Promise<GuestVaultTrack[] | null> {
  if (!supportedIdb()) return null;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const rows = await idbRequest(store.getAll() as IDBRequest<GuestVaultTrack[]>);
    db.close();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return null;
  }
}

async function writeIdbTracks(tracks: GuestVaultTrack[]): Promise<boolean> {
  if (!supportedIdb()) return false;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.clear();
    for (const track of tracks.slice(0, MAX_GUEST_TRACKS)) {
      store.put(track);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

function normalizeTrack(
  input: Partial<GuestVaultTrack> & { title?: string },
  existing?: GuestVaultTrack | null,
): GuestVaultTrack {
  const deviceId = getOrCreateVaultDeviceId();
  const id = input.id || existing?.id || `guest-${newId()}`;
  return {
    id,
    deviceId,
    title: (input.title ?? existing?.title ?? "Untitled Track").trim() || "Untitled Track",
    style: (input.style ?? existing?.style ?? "Custom").trim() || "Custom",
    status: input.status ?? existing?.status ?? "processing",
    masterUrl: input.masterUrl !== undefined ? input.masterUrl : (existing?.masterUrl ?? null),
    instrumentalUrl:
      input.instrumentalUrl !== undefined ? input.instrumentalUrl : (existing?.instrumentalUrl ?? null),
    vocalUrl: input.vocalUrl !== undefined ? input.vocalUrl : (existing?.vocalUrl ?? null),
    rawAudioUrl: input.rawAudioUrl !== undefined ? input.rawAudioUrl : (existing?.rawAudioUrl ?? null),
    tokensUsed:
      typeof input.tokensUsed === "number"
        ? input.tokensUsed
        : (existing?.tokensUsed ?? (input.status === "completed" ? 1 : 0)),
    createdAt: existing?.createdAt ?? input.createdAt ?? new Date().toISOString(),
    artistName: (input.artistName ?? existing?.artistName ?? "Unknown Artist").trim() || "Unknown Artist",
    albumName: (input.albumName ?? existing?.albumName ?? "Singles").trim() || "Singles",
  };
}

function sortNewest(tracks: GuestVaultTrack[]): GuestVaultTrack[] {
  return [...tracks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Newest-first guest vault for this device. */
export async function listGuestVaultTracks(): Promise<GuestVaultTrack[]> {
  if (typeof window === "undefined") return [];
  const idb = await readIdbTracks();
  if (idb) return sortNewest(idb);
  return sortNewest(readLocalStorageTracks());
}

/** Insert or update a guest vault row; mirrors cloud vault fields. */
export async function upsertGuestVaultTrack(
  input: Partial<GuestVaultTrack> & { title?: string; status?: GuestVaultTrack["status"] },
): Promise<GuestVaultTrack> {
  const current = await listGuestVaultTracks();
  const existing = input.id ? current.find((row) => row.id === input.id) ?? null : null;
  const next = normalizeTrack(input, existing);
  const without = current.filter((row) => row.id !== next.id);
  const merged = sortNewest([next, ...without]).slice(0, MAX_GUEST_TRACKS);
  const wroteIdb = await writeIdbTracks(merged);
  if (!wroteIdb) writeLocalStorageTracks(merged);
  else writeLocalStorageTracks(merged); // keep LS mirror for recovery
  return next;
}

export async function deleteGuestVaultTrack(id: string): Promise<void> {
  const current = await listGuestVaultTracks();
  const next = current.filter((row) => row.id !== id);
  const wroteIdb = await writeIdbTracks(next);
  if (!wroteIdb) writeLocalStorageTracks(next);
  else writeLocalStorageTracks(next);
}

export async function clearGuestVaultTracks(): Promise<void> {
  await writeIdbTracks([]);
  writeLocalStorageTracks([]);
}

/** Shape guest rows for the shared vault UI / events. */
export function guestTrackToPayload(track: GuestVaultTrack): VaultTrackPayload {
  return {
    id: track.id,
    title: track.title,
    style: track.style,
    status: track.status,
    master_url: track.masterUrl,
    instrumental_url: track.instrumentalUrl,
    vocal_url: track.vocalUrl,
    raw_audio_url: track.rawAudioUrl,
    created_at: track.createdAt,
    artist_name: track.artistName,
    album_name: track.albumName,
  };
}

/** Claimable rows — completed guest tracks with a playable master URL. */
export async function listClaimableGuestVaultTracks(): Promise<GuestVaultTrack[]> {
  const tracks = await listGuestVaultTracks();
  return tracks.filter(
    (row) =>
      row.status === "completed" &&
      Boolean(row.masterUrl) &&
      /^https?:\/\//i.test(row.masterUrl ?? ""),
  );
}
