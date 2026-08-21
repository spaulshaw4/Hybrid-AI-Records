/**
 * Timezone validation + safe fallback.
 *
 * Slots are stored as a wall-clock date/time plus an IANA zone id supplied by
 * the browser. That id can be missing, stale, misspelled, or a non-IANA alias,
 * which would otherwise make `Intl.DateTimeFormat` throw and leave a
 * confirmation email showing a broken or wrong local time. Everything that
 * renders a session time runs through `resolveTimeZone` first.
 */

/** Used whenever the requested zone cannot be trusted (the studio's own zone). */
export const FALLBACK_TIME_ZONE = "America/New_York";

export interface ResolvedTimeZone {
  /** A zone id guaranteed to be accepted by Intl. */
  timeZone: string;
  /** Whether the caller's requested zone was usable as-is. */
  valid: boolean;
  /** Exactly what the caller asked for (trimmed), for diagnostics/messaging. */
  requested: string;
}

/** True when `Intl` accepts the id as a real IANA time zone. */
export function isValidTimeZone(value: string | null | undefined): boolean {
  const tz = (value ?? "").trim();
  if (!tz) return false;
  // "UTC" and "Etc/*" are valid; anything Intl rejects throws RangeError.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Validate a zone id, falling back to the studio zone when it is unusable. */
export function resolveTimeZone(
  value: string | null | undefined,
  fallback: string = FALLBACK_TIME_ZONE,
): ResolvedTimeZone {
  const requested = (value ?? "").trim();
  if (isValidTimeZone(requested)) return { timeZone: requested, valid: true, requested };
  const safe = isValidTimeZone(fallback) ? fallback : "UTC";
  return { timeZone: safe, valid: false, requested };
}

/** Short zone name at a given instant, e.g. "EDT" or "GMT+3". */
export function timeZoneAbbreviation(timeZone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * Human label for emails: "America/New_York (EDT)". When the artist's zone was
 * invalid the label says so plainly so nobody reads the time as their own.
 */
export function timeZoneLabel(
  value: string | null | undefined,
  at: Date = new Date(),
): string {
  const resolved = resolveTimeZone(value);
  const abbr = timeZoneAbbreviation(resolved.timeZone, at);
  const base = abbr ? `${resolved.timeZone} (${abbr})` : resolved.timeZone;
  if (resolved.valid) return base;
  return resolved.requested
    ? `${base} — “${resolved.requested}” was not recognized, times shown in studio time`
    : `${base} — times shown in studio time`;
}
