/**
 * Device-local stem blobs so Raw / Vocal / Instrumental / Mastered
 * playback can switch without re-downloading.
 *
 * IndexedDB keys are `studio_stems_${taskId}`.
 */

export const STEM_CACHE_KEY_PREFIX = "studio_stems_";

export type StemKind = "raw" | "vocal" | "instrumental" | "mastered";

export type StudioStemRecord = {
  id: string;
  taskId: string;
  raw?: Blob;
  vocal?: Blob;
  instrumental?: Blob;
  mastered?: Blob;
  cachedAt: number;
};

const DB_NAME = "hybrid-studio-stems";
const STORE = "stems";
const DB_VERSION = 1;

const objectUrls = new Map<string, string>();

export function studioStemCacheKey(taskId: string): string {
  const safe = taskId.trim() || "unknown";
  return `${STEM_CACHE_KEY_PREFIX}${safe}`;
}

function supported(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
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

async function fetchAudioBlob(url: string): Promise<Blob | null> {
  if (!url.trim()) return null;
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

export async function readStudioStemCache(taskId: string): Promise<StudioStemRecord | null> {
  if (!supported()) return null;
  try {
    const db = await openDb();
    const record = await idbRequest(
      db.transaction(STORE, "readonly").objectStore(STORE).get(studioStemCacheKey(taskId)),
    );
    db.close();
    return (record as StudioStemRecord | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function writeStudioStemCache(record: StudioStemRecord): Promise<void> {
  if (!supported()) return;
  const db = await openDb();
  await idbRequest(db.transaction(STORE, "readwrite").objectStore(STORE).put(record));
  db.close();
}

export async function cacheStudioStemBlobs(
  taskId: string,
  urls: Partial<Record<StemKind, string | null | undefined>>,
): Promise<StudioStemRecord | null> {
  if (!taskId.trim()) return null;
  const existing = (await readStudioStemCache(taskId)) ?? {
    id: studioStemCacheKey(taskId),
    taskId,
    cachedAt: Date.now(),
  };
  const kinds: StemKind[] = ["raw", "vocal", "instrumental", "mastered"];
  for (const kind of kinds) {
    if (existing[kind]) continue;
    const url = urls[kind];
    if (!url) continue;
    const blob = await fetchAudioBlob(url);
    if (blob) existing[kind] = blob;
  }
  existing.cachedAt = Date.now();
  existing.id = studioStemCacheKey(taskId);
  await writeStudioStemCache(existing);
  return existing;
}

export async function stemObjectUrl(
  taskId: string,
  kind: StemKind,
  fallbackUrl?: string | null,
): Promise<string | null> {
  const cacheKey = `${studioStemCacheKey(taskId)}:${kind}`;
  const cached = await readStudioStemCache(taskId);
  let blob = cached?.[kind];
  if (!blob && fallbackUrl) {
    blob = (await fetchAudioBlob(fallbackUrl)) ?? undefined;
    if (blob) {
      await writeStudioStemCache({
        id: studioStemCacheKey(taskId),
        taskId,
        cachedAt: Date.now(),
        ...(cached ?? {}),
        [kind]: blob,
      });
    }
  }
  if (!blob) return fallbackUrl?.trim() || null;
  const previous = objectUrls.get(cacheKey);
  if (previous) URL.revokeObjectURL(previous);
  const next = URL.createObjectURL(blob);
  objectUrls.set(cacheKey, next);
  return next;
}

export function revokeStemObjectUrls(taskId?: string): void {
  const prefix = taskId ? `${studioStemCacheKey(taskId)}:` : "";
  for (const [key, url] of objectUrls) {
    if (prefix && !key.startsWith(prefix)) continue;
    URL.revokeObjectURL(url);
    objectUrls.delete(key);
  }
}
