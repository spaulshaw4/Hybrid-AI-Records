/**
 * Local persistence for an artist's vocal-session booking.
 *
 * Reschedules are additive: each round is appended, and the original booking
 * details (artist, email, timezone, package, first request id) are never
 * overwritten, so a second or third reschedule can't lose the first booking.
 */
export type BookingSlot = { date: string; time: string };

export type BookingRound = {
  round: number;
  slots: BookingSlot[];
  sentAt: string;
  requestId: string | null;
};

export type StoredBooking = {
  /** Id of the ORIGINAL request — every reschedule points back at this. */
  requestId: string;
  artist: string;
  email: string;
  timezone: string;
  packageLabel: string | null;
  notes: string | null;
  bookedAt: string;
  rounds: BookingRound[];
};

const KEY = "hybrid:vocal-session-booking";

export function loadBooking(): StoredBooking | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredBooking;
    if (!parsed?.requestId || !Array.isArray(parsed.rounds) || parsed.rounds.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveBooking(booking: StoredBooking) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(booking));
  } catch {
    /* storage full or blocked — the booking still exists server-side */
  }
}

export function clearBooking() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
