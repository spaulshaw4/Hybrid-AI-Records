/**
 * Device-local encryption for saved application drafts.
 *
 * Drafts contain an artist's contact details and unreleased track notes, so
 * they are encrypted before they ever touch localStorage. The AES-GCM key is
 * generated in the browser and kept in IndexedDB as a NON-EXTRACTABLE
 * CryptoKey: the raw key bytes cannot be read back by any script (or by
 * anyone copying localStorage), only used for encrypt/decrypt on this device.
 */

const DB_NAME = "hybrid-draft-vault";
const STORE = "keys";
const KEY_ID = "draft-aes-gcm-v1";

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const idbGet = async (key: string): Promise<CryptoKey | undefined> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
    req.onerror = () => reject(req.error);
  });
};

const idbPut = async (key: string, value: CryptoKey): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

let keyPromise: Promise<CryptoKey | null> | null = null;

const supported = () =>
  typeof window !== "undefined" &&
  typeof indexedDB !== "undefined" &&
  typeof crypto !== "undefined" &&
  Boolean(crypto.subtle);

/** The device key, created on first use. Null when the browser can't do it. */
export const getDraftKey = (): Promise<CryptoKey | null> => {
  if (!supported()) return Promise.resolve(null);
  if (!keyPromise) {
    keyPromise = (async () => {
      try {
        const existing = await idbGet(KEY_ID);
        if (existing) return existing;
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]);
        await idbPut(KEY_ID, key);
        return key;
      } catch {
        return null;
      }
    })();
  }
  return keyPromise;
};

const toB64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const fromB64 = (b64: string) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

/** Envelope marker so encrypted records are distinguishable from legacy JSON. */
const ENVELOPE = "harenc1:";

export const isEncryptedRecord = (raw: string) => raw.startsWith(ENVELOPE);

/** Encrypt a UTF-8 string. Returns null when crypto is unavailable. */
export const encryptString = async (plaintext: string): Promise<string | null> => {
  const key = await getDraftKey();
  if (!key) return null;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    );
    return `${ENVELOPE}${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
  } catch {
    return null;
  }
};

/** Decrypt an envelope produced by encryptString. Null when it can't be read. */
export const decryptString = async (record: string): Promise<string | null> => {
  if (!isEncryptedRecord(record)) return null;
  const key = await getDraftKey();
  if (!key) return null;
  try {
    const [ivPart, ctPart] = record.slice(ENVELOPE.length).split(".");
    if (!ivPart || !ctPart) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(ivPart) },
      key,
      fromB64(ctPart),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
};
