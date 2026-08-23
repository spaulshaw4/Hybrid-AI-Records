/**
 * Device-local custom vocal takes (IndexedDB).
 *
 * Keys use `hybrid_vocal_profile_${id}`. The last-used id is remembered in
 * localStorage so the studio can restore the most recent take on load.
 */

export const VOCAL_PROFILE_KEY_PREFIX = "hybrid_vocal_profile_";
export const VOCAL_PROFILE_LAST_ID_KEY = "hybrid_vocal_profile_last_id";

const DB_NAME = "hybrid-vocal-library";
const STORE = "profiles";
const DB_VERSION = 1;

export type VocalProfileGender = "m" | "f" | "auto";

export type LocalVocalProfile = {
  id: string;
  name: string;
  audioBlob: Blob;
  gender: VocalProfileGender;
  createdAt: string;
  duration: number;
};

export function vocalProfileStorageKey(id: string): string {
  return `${VOCAL_PROFILE_KEY_PREFIX}${id}`;
}

export function isLocalVocalProfileId(value: string | undefined): boolean {
  return Boolean(value?.startsWith(VOCAL_PROFILE_KEY_PREFIX));
}

export function formatVocalDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function newProfileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function supported(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
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

export function readLastVocalProfileId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(VOCAL_PROFILE_LAST_ID_KEY);
  } catch {
    return null;
  }
}

export function writeLastVocalProfileId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOCAL_PROFILE_LAST_ID_KEY, id);
  } catch {
    /* private mode */
  }
}

export async function saveVocalProfile(input: {
  name?: string;
  audioBlob: Blob;
  gender?: VocalProfileGender;
  duration: number;
}): Promise<LocalVocalProfile> {
  if (!supported()) throw new Error("This browser cannot save vocal takes locally.");
  const id = newProfileId();
  const profile: LocalVocalProfile = {
    id,
    name: input.name?.trim() || `Main Lead Take ${new Date().toLocaleString()}`,
    audioBlob: input.audioBlob,
    gender: input.gender ?? "auto",
    createdAt: new Date().toISOString(),
    duration: Math.max(0, input.duration),
  };
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(profile, vocalProfileStorageKey(id));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  writeLastVocalProfileId(id);
  return profile;
}

export async function listVocalProfiles(): Promise<LocalVocalProfile[]> {
  if (!supported()) return [];
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const rows = await idbRequest(tx.objectStore(STORE).getAll());
  return (Array.isArray(rows) ? rows : [])
    .filter((row): row is LocalVocalProfile => Boolean(row && typeof row === "object" && row.id))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function getVocalProfile(id: string): Promise<LocalVocalProfile | null> {
  if (!supported() || !id) return null;
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const row = await idbRequest(tx.objectStore(STORE).get(vocalProfileStorageKey(id)));
  return row && typeof row === "object" ? (row as LocalVocalProfile) : null;
}

export async function deleteVocalProfile(id: string): Promise<void> {
  if (!supported() || !id) return;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(vocalProfileStorageKey(id));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  if (readLastVocalProfileId() === id) {
    try {
      window.localStorage.removeItem(VOCAL_PROFILE_LAST_ID_KEY);
    } catch {
      /* private mode */
    }
  }
}
