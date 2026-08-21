/**
 * Named Studio payload presets — style, genre chips, vocal traits and lyric
 * blocks — persisted locally so a producer can reload a setup instantly.
 */
export const PRESET_KEY = "hybrid.studio.presets";
export const PRESET_MAX = 24;

export type StudioPreset = {
  id: string;
  name: string;
  at: number;
  title: string;
  style: string;
  activeGenres: string[];
  vocalGender: string | null;
  vocalStyle: string | null;
  onlyEnglish: boolean;
  lyrics: string;
};

export type StudioPresetInput = Omit<StudioPreset, "id" | "at">;

function isPreset(value: unknown): value is StudioPreset {
  const p = value as StudioPreset | null;
  return Boolean(p && typeof p.id === "string" && typeof p.name === "string" && typeof p.style === "string");
}

export function readPresets(): StudioPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PRESET_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPreset).slice(0, PRESET_MAX);
  } catch {
    return [];
  }
}

function persist(next: StudioPreset[]): StudioPreset[] {
  try {
    window.localStorage.setItem(PRESET_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — presets stay in memory for this session */
  }
  return next;
}

/** Saves under a name, replacing any existing preset with the same name. */
export function savePreset(input: StudioPresetInput): StudioPreset[] {
  const name = input.name.trim();
  const preset: StudioPreset = {
    ...input,
    name,
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `preset-${Date.now()}`,
    at: Date.now(),
  };
  const rest = readPresets().filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  return persist([preset, ...rest].slice(0, PRESET_MAX));
}

export function deletePreset(id: string): StudioPreset[] {
  return persist(readPresets().filter((p) => p.id !== id));
}
