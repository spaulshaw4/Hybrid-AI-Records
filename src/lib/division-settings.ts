import { useSyncExternalStore } from "react";
import type { Division } from "@/lib/divisions";

/** Single source of truth for the Legacy Records Division wording. */
export const JESTER_DIVISION_NAME = "The Jester AI Legacy Records Division";
/** Short form used where a full name would overflow (page titles, meta). */
export const JESTER_DIVISION_SHORT_NAME = "Jester AI Legacy Division";

export const DEFAULT_DIVISION_NAMES: Record<Division, string> = {
  jester: JESTER_DIVISION_NAME,
  lithuania: "Hybrid AI Records Lithuania",
  nigeria: "Hybrid AI Records Nigerian Division",
  usa: "Hybrid AI Records USA Division",
};

export type DivisionNames = Record<Division, string>;

const STORAGE_KEY = "hybrid.division-names.v1";

/** Older labels that must be normalized to the current wording on load. */
const LEGACY_NAMES: Record<Division, string[]> = {
  jester: [],
  lithuania: [
    "Lithuania Division",
    "Lithuanian Division",
    "Hybrid AI Records Lithuanian",
    "Hybrid AI Records Lithuanian Division",
    "Lithuanian Division Hybrid AI Records",
  ],
  nigeria: [],
  usa: [],
};

const normalizeName = (division: Division, value: string): string =>
  LEGACY_NAMES[division].some((legacy) => legacy.toLowerCase() === value.toLowerCase())
    ? DEFAULT_DIVISION_NAMES[division]
    : value;

let current: DivisionNames = { ...DEFAULT_DIVISION_NAMES };
let hydrated = false;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

function readStorage(): DivisionNames {
  if (typeof window === "undefined") return { ...DEFAULT_DIVISION_NAMES };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DIVISION_NAMES };
    const parsed = JSON.parse(raw) as Partial<DivisionNames>;
    const next = { ...DEFAULT_DIVISION_NAMES };
    for (const key of Object.keys(DEFAULT_DIVISION_NAMES) as Division[]) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.trim()) next[key] = normalizeName(key, value.trim());
    }
    return next;
  } catch {
    return { ...DEFAULT_DIVISION_NAMES };
  }
}

/** Loads persisted names and the active division once, on the client. */
function ensureHydrated() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  current = readStorage();
  activeDivision = readActiveStorage();
}

export function getDivisionNames(): DivisionNames {
  ensureHydrated();
  return current;
}

export function setDivisionName(division: Division, name: string) {
  ensureHydrated();
  const value = name.trim() || DEFAULT_DIVISION_NAMES[division];
  if (current[division] === value) return;
  current = { ...current, [division]: value };
  persist();
  emit();
}

/** Max characters allowed for a custom division name. */
export const DIVISION_NAME_MAX_LENGTH = 60;
/** Min characters allowed for a custom division name. */
export const DIVISION_NAME_MIN_LENGTH = 3;

export type DivisionNameErrors = Partial<Record<Division, string>>;

/**
 * Validates a full set of draft names: non-empty, length-bounded, and unique
 * across divisions (case- and whitespace-insensitive).
 */
export function validateDivisionNames(draft: DivisionNames): DivisionNameErrors {
  const errors: DivisionNameErrors = {};
  const keys = Object.keys(DEFAULT_DIVISION_NAMES) as Division[];
  const seen = new Map<string, Division>();

  for (const key of keys) {
    const value = (draft[key] ?? "").trim();
    if (!value) {
      errors[key] = "Name cannot be empty.";
      continue;
    }
    if (value.length < DIVISION_NAME_MIN_LENGTH) {
      errors[key] = `Use at least ${DIVISION_NAME_MIN_LENGTH} characters.`;
      continue;
    }
    if (value.length > DIVISION_NAME_MAX_LENGTH) {
      errors[key] = `Keep it under ${DIVISION_NAME_MAX_LENGTH} characters.`;
      continue;
    }
    if (!/^[\p{L}\p{N} .,'&()\-\/]+$/u.test(value)) {
      errors[key] = "Only letters, numbers and . , ' & ( ) - / are allowed.";
      continue;
    }
    const fingerprint = value.toLowerCase().replace(/\s+/g, " ");
    const clash = seen.get(fingerprint);
    if (clash) {
      errors[key] = "Duplicate name — each division needs a unique name.";
      errors[clash] = "Duplicate name — each division needs a unique name.";
      continue;
    }
    seen.set(fingerprint, key);
  }

  return errors;
}

export function resetDivisionNames() {
  current = { ...DEFAULT_DIVISION_NAMES };
  activeDivision = DEFAULT_ACTIVE_DIVISION;
  persist();
  persistActive();
  emit();
}

/** Division shown as the site's active label when nothing is stored. */
export const DEFAULT_ACTIVE_DIVISION: Division = "usa";
const ACTIVE_STORAGE_KEY = "hybrid.active-division.v1";

const isDivision = (v: unknown): v is Division =>
  typeof v === "string" && v in DEFAULT_DIVISION_NAMES;

let activeDivision: Division = DEFAULT_ACTIVE_DIVISION;

function readActiveStorage(): Division {
  if (typeof window === "undefined") return DEFAULT_ACTIVE_DIVISION;
  try {
    const raw = window.localStorage.getItem(ACTIVE_STORAGE_KEY);
    return isDivision(raw) ? raw : DEFAULT_ACTIVE_DIVISION;
  } catch {
    return DEFAULT_ACTIVE_DIVISION;
  }
}

function persistActive() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_STORAGE_KEY, activeDivision);
  } catch {
    /* storage unavailable — active division stays in memory for this session */
  }
}

export function getActiveDivision(): Division {
  ensureHydrated();
  return activeDivision;
}

/** Persists the active division and updates every subscriber immediately. */
export function setActiveDivision(division: Division) {
  ensureHydrated();
  if (!isDivision(division) || activeDivision === division) return;
  activeDivision = division;
  persistActive();
  emit();
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable — names stay in memory for this session */
  }
}

function subscribe(listener: () => void) {
  ensureHydrated();
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      current = readStorage();
      emit();
    }
    if (e.key === ACTIVE_STORAGE_KEY) {
      activeDivision = readActiveStorage();
      emit();
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

const serverSnapshot = () => DEFAULT_DIVISION_NAMES;

/** Live division names — updates every badge, tooltip and alt text when edited. */
export function useDivisionNames(): DivisionNames {
  return useSyncExternalStore(subscribe, getDivisionNames, serverSnapshot);
}

const serverActiveSnapshot = () => DEFAULT_ACTIVE_DIVISION;

/** Live active division — re-renders instantly when changed in Settings. */
export function useActiveDivision(): Division {
  return useSyncExternalStore(subscribe, getActiveDivision, serverActiveSnapshot);
}
