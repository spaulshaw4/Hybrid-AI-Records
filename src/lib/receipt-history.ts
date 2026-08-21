import type { RecapPdfInput } from "./application-pdf";

/**
 * Local, device-scoped history of submitted track requests.
 * Stored in localStorage so an artist can find, search and re-open the
 * receipt for any submission made from this browser.
 */
export type ReceiptRecord = {
  reference: string | null;
  artist: string;
  email: string;
  packageLabel: string;
  link: string;
  notes: string;
  acknowledged: boolean;
  attachment: RecapPdfInput["attachment"];
  timeline: RecapPdfInput["timeline"];
  submittedAt: string;
};

const KEY = "hybrid-receipt-history-v1";
const MAX_ENTRIES = 50;

function canUse() {
  return typeof window !== "undefined" && !!window.localStorage;
}

export function readReceiptHistory(): ReceiptRecord[] {
  if (!canUse()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is ReceiptRecord => !!r && typeof r === "object");
  } catch {
    return [];
  }
}

/** Adds (or replaces, by reference) a submission in the local history. */
export function recordReceipt(entry: ReceiptRecord) {
  if (!canUse()) return;
  try {
    const existing = readReceiptHistory().filter(
      (r) => !(entry.reference && r.reference === entry.reference),
    );
    const next = [entry, ...existing].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked — history is a convenience, never block a submit */
  }
}

export function removeReceipt(reference: string | null, submittedAt: string) {
  if (!canUse()) return;
  try {
    const next = readReceiptHistory().filter(
      (r) => !(r.reference === reference && r.submittedAt === submittedAt),
    );
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function clearReceiptHistory() {
  if (!canUse()) return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Case-insensitive match across reference, artist, email, package and notes. */
export function matchesReceiptQuery(record: ReceiptRecord, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    record.reference,
    record.artist,
    record.email,
    record.packageLabel,
    record.notes,
    record.attachment?.name,
  ]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
}
