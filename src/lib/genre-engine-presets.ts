import {
  clampBpm,
  clampInfluence,
  clampStyleInfluence,
  clampWeirdness,
  DEFAULT_BPM,
  DEFAULT_INFLUENCE,
  DEFAULT_STYLE_INFLUENCE,
  DEFAULT_WEIRDNESS,
} from "@/lib/engine-controls";

/** Optimized engine sliders for a genre — casual users can generate without tweaking. */
export type GenreEnginePreset = {
  bpm: number;
  audioInfluence: number;
  styleInfluence: number;
  weirdness: number;
};

export const DEFAULT_GENRE_PRESET: GenreEnginePreset = {
  bpm: DEFAULT_BPM,
  audioInfluence: DEFAULT_INFLUENCE,
  styleInfluence: DEFAULT_STYLE_INFLUENCE,
  weirdness: DEFAULT_WEIRDNESS,
};

/** Named overrides for the studio's one-tap chips and common catalog picks. */
const NAMED_PRESETS: Record<string, Partial<GenreEnginePreset>> = {
  "Heavy Rock": { bpm: 92, styleInfluence: 82, weirdness: 12, audioInfluence: 80 },
  "Nu-Metal": { bpm: 102, styleInfluence: 80, weirdness: 22, audioInfluence: 78 },
  "Rap-Rock": { bpm: 96, styleInfluence: 75, weirdness: 20, audioInfluence: 76 },
  Cinematic: { bpm: 84, styleInfluence: 70, weirdness: 28, audioInfluence: 72 },
  Trap: { bpm: 140, styleInfluence: 74, weirdness: 16, audioInfluence: 78 },
  "Hybrid Orchestral": { bpm: 88, styleInfluence: 72, weirdness: 30, audioInfluence: 70 },
  Industrial: { bpm: 118, styleInfluence: 76, weirdness: 35, audioInfluence: 74 },
  Acoustic: { bpm: 86, styleInfluence: 68, weirdness: 8, audioInfluence: 82 },
  Pop: { bpm: 118, styleInfluence: 70, weirdness: 14 },
  EDM: { bpm: 128, styleInfluence: 76, weirdness: 22 },
  House: { bpm: 124, styleInfluence: 74, weirdness: 18 },
  "Hip-Hop": { bpm: 92, styleInfluence: 72, weirdness: 16 },
  Drill: { bpm: 142, styleInfluence: 78, weirdness: 18 },
  "R&B": { bpm: 90, styleInfluence: 68, weirdness: 12 },
  Afrobeats: { bpm: 110, styleInfluence: 74, weirdness: 16 },
  Country: { bpm: 96, styleInfluence: 76, weirdness: 10 },
  "Lo-Fi": { bpm: 84, styleInfluence: 62, weirdness: 20 },
  Ambient: { bpm: 72, styleInfluence: 55, weirdness: 35 },
  "K-Pop": { bpm: 128, styleInfluence: 80, weirdness: 18 },
  Reggaeton: { bpm: 96, styleInfluence: 78, weirdness: 14 },
};

function familyFallback(genre: string): Partial<GenreEnginePreset> {
  const g = genre.toLowerCase();
  if (/metal|hardcore|punk|industrial/.test(g)) {
    return { bpm: 100, styleInfluence: 80, weirdness: 22, audioInfluence: 78 };
  }
  if (/rock/.test(g)) return { bpm: 108, styleInfluence: 76, weirdness: 14, audioInfluence: 78 };
  if (/trap|drill|rap|hip-?hop|boom bap/.test(g)) {
    return { bpm: 138, styleInfluence: 72, weirdness: 18, audioInfluence: 76 };
  }
  if (/house|edm|techno|trance|electro|synth|dance/.test(g)) {
    return { bpm: 126, styleInfluence: 74, weirdness: 20, audioInfluence: 74 };
  }
  if (/r&b|soul|gospel/.test(g)) return { bpm: 88, styleInfluence: 68, weirdness: 12, audioInfluence: 80 };
  if (/country|folk|bluegrass|americana|acoustic|blues/.test(g)) {
    return { bpm: 94, styleInfluence: 74, weirdness: 10, audioInfluence: 82 };
  }
  if (/cinematic|orchestral|ambient/.test(g)) {
    return { bpm: 80, styleInfluence: 68, weirdness: 28, audioInfluence: 70 };
  }
  if (/latin|reggaeton|afro|dancehall|reggae/.test(g)) {
    return { bpm: 104, styleInfluence: 76, weirdness: 16, audioInfluence: 76 };
  }
  if (/pop/.test(g)) return { bpm: 120, styleInfluence: 72, weirdness: 14, audioInfluence: 76 };
  if (/lo-fi|downtempo|trip-hop/.test(g)) {
    return { bpm: 82, styleInfluence: 60, weirdness: 22, audioInfluence: 70 };
  }
  if (/experimental|glitch|noise|psychedelic/.test(g)) {
    return { bpm: 100, styleInfluence: 50, weirdness: 55, audioInfluence: 62 };
  }
  return {};
}

function clampPreset(preset: GenreEnginePreset): GenreEnginePreset {
  return {
    bpm: clampBpm(preset.bpm),
    audioInfluence: clampInfluence(preset.audioInfluence),
    styleInfluence: clampStyleInfluence(preset.styleInfluence),
    weirdness: clampWeirdness(preset.weirdness),
  };
}

/**
 * Slider defaults for the latest selected genre. Earlier tags still blend in
 * the prompt; the last chip is the one casual users just tapped.
 */
export function presetForGenres(styles: string[]): GenreEnginePreset {
  if (!styles.length) return { ...DEFAULT_GENRE_PRESET };
  const last = styles[styles.length - 1] ?? "";
  return clampPreset({
    ...DEFAULT_GENRE_PRESET,
    ...familyFallback(last),
    ...(NAMED_PRESETS[last] ?? {}),
  });
}
