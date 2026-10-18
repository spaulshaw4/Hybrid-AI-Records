import type { CharacterProfile } from "@/lib/character-profile";

export type ProductionMode = "auto" | "character";

export type VideoStyleId =
  | "symphonic-rock"
  | "amapiano"
  | "roots-reggae"
  | "bedroom-pop"
  | "custom";

export type TimelineMarkerLabel = "verse" | "chorus" | "bridge" | "drop";

export type TimelineMarker = {
  label: TimelineMarkerLabel;
  start: number;
  end: number;
};

export type ArtistPersona = {
  id: string;
  name: string;
  look: string;
  profile: Omit<CharacterProfile, "referenceImage">;
};

export type VideoStylePreset = {
  id: VideoStyleId;
  label: string;
  custom: boolean;
  /** Existing visual-style id. Not shown on the studio screen. */
  styleMode: string;
  /** Existing genre-law id, when one applies. */
  genreId: string | null;
  /** Hidden direction sent to the shot director. Not rendered. */
  direction: string;
};

export const VIDEO_STYLE_PRESETS: VideoStylePreset[] = [
  {
    id: "symphonic-rock",
    label: "Symphonic Rock",
    custom: false,
    styleMode: "imax-epic",
    genreId: "rock",
    direction:
      "Symphonic rock concert film: orchestra and electric guitars share one stage, cathedral halls and warehouse amp stacks, tungsten par cans, dust in the beams, formal black and leather.",
  },
  {
    id: "amapiano",
    label: "Amapiano",
    custom: false,
    styleMode: "afrobeats",
    genreId: "amapiano",
    direction:
      "Amapiano courtyard film: log-drum groove, sunlit township streets, textile colour, a dance circle, warm dusk string lights, contemporary fashion.",
  },
  {
    id: "roots-reggae",
    label: "Roots Reggae",
    custom: false,
    styleMode: "documentary",
    genreId: "roots",
    direction:
      "Roots reggae session: wooden sound-system yard, one-drop rhythm, riverbank and porch, linen and natural hair, late-afternoon sun.",
  },
  {
    id: "bedroom-pop",
    label: "Bedroom Pop",
    custom: false,
    styleMode: "dreampop",
    genreId: null,
    direction:
      "Bedroom pop film: a small rented room, a desk lamp, knit sweater, notebook and cassette deck, rain on the window, soft pastel haze, intimate and moving.",
  },
  {
    id: "custom",
    label: "Custom",
    custom: true,
    styleMode: "photorealistic",
    genreId: null,
    direction: "",
  },
];

export const ARTIST_PERSONAS: ArtistPersona[] = [
  {
    id: "frontperson",
    name: "Frontperson",
    look: "Sharp features, leather jacket, white tee",
    profile: {
      name: "Frontperson",
      archetype: "lead singer",
      appearance: "sharp jaw, short dark hair, focused eyes, light stubble",
      wardrobe: "black leather jacket, plain white t-shirt, dark jeans, black boots",
    },
  },
  {
    id: "nightcrooner",
    name: "Nightcrooner",
    look: "Warm brown skin, silk shirt, gold hoop",
    profile: {
      name: "Nightcrooner",
      archetype: "vocalist",
      appearance: "warm brown skin, shoulder-length curls, calm eyes, gold hoop earring",
      wardrobe: "black silk shirt, tailored trousers, thin gold chain",
    },
  },
  {
    id: "roots-voice",
    name: "Roots Voice",
    look: "Natural hair, linen shirt, worn denim",
    profile: {
      name: "Roots Voice",
      archetype: "singer",
      appearance: "natural hair, open face, quiet expression, sun-worn skin",
      wardrobe: "cream linen shirt, worn denim, leather sandals",
    },
  },
  {
    id: "bedroom-writer",
    name: "Bedroom Writer",
    look: "Soft features, knit sweater, lamp light",
    profile: {
      name: "Bedroom Writer",
      archetype: "singer-songwriter",
      appearance: "soft features, tousled hair, tired eyes, headphones around the neck",
      wardrobe: "oversized oatmeal knit sweater, dark trousers",
    },
  },
];

const SECTION_TO_MARKER: Record<string, TimelineMarkerLabel> = {
  intro: "verse",
  build: "verse",
  verse: "verse",
  chorus: "chorus",
  drop: "drop",
  breakdown: "bridge",
  bridge: "bridge",
  outro: "verse",
};

export function presetById(id: string | null | undefined): VideoStylePreset | null {
  return VIDEO_STYLE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function personaById(id: string | null | undefined): ArtistPersona | null {
  return ARTIST_PERSONAS.find((persona) => persona.id === id) ?? null;
}

/**
 * Markers for the shot director.
 * When the browser analyser returned sections, those sections are mapped onto
 * verse / chorus / bridge / drop. Otherwise the track is split into four even
 * parts. This is not a librosa analysis.
 */
export function timelineMarkersFromSections(
  sections: { start: number; end: number; label: string }[],
  durationSeconds: number,
): TimelineMarker[] {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0 || sections.length === 0) {
    return evenTimelineMarkers(duration);
  }
  const markers = sections
    .filter(
      (section) =>
        Number.isFinite(section.start) &&
        Number.isFinite(section.end) &&
        section.end > section.start,
    )
    .map((section) => ({
      label: SECTION_TO_MARKER[section.label] ?? "verse",
      start: Number(section.start.toFixed(2)),
      end: Number(section.end.toFixed(2)),
    }));
  return markers.length > 0 ? markers : evenTimelineMarkers(duration);
}

export function evenTimelineMarkers(durationSeconds: number): TimelineMarker[] {
  const duration = Math.max(
    4,
    Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 4,
  );
  const labels: TimelineMarkerLabel[] = ["verse", "chorus", "bridge", "drop"];
  const slice = duration / labels.length;
  return labels.map((label, index) => ({
    label,
    start: Number((slice * index).toFixed(2)),
    end: Number((index === labels.length - 1 ? duration : slice * (index + 1)).toFixed(2)),
  }));
}

export function videoStudioGate(input: {
  hasAudio: boolean;
  mode: ProductionMode;
  personaId: string | null;
  hasCharacterImage: boolean;
  styleId: VideoStyleId | null;
  customText: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.hasAudio) return { ok: false, reason: "Add a master track first." };
  if (!input.styleId) return { ok: false, reason: "Choose a visual style." };
  if (input.styleId === "custom" && input.customText.trim().length < 3) {
    return { ok: false, reason: "Describe the custom style." };
  }
  if (input.mode === "character" && !input.personaId) {
    return { ok: false, reason: "Choose an artist profile." };
  }
  if (input.mode === "character" && !input.hasCharacterImage) {
    return { ok: false, reason: "Add a character image." };
  }
  return { ok: true };
}

export function hiddenStyleDirection(styleId: VideoStyleId | null, customText: string): string {
  const preset = presetById(styleId);
  if (!preset) return "";
  if (preset.custom) return customText.trim();
  return preset.direction;
}

export function characterDescriptionFor(mode: ProductionMode, personaId: string | null): string {
  if (mode !== "character") return "";
  const persona = personaById(personaId);
  if (!persona) return "";
  return `${persona.profile.name}, ${persona.profile.appearance}, wearing ${persona.profile.wardrobe}.`;
}

export function scriptSeed(
  styleId: VideoStyleId | null,
  customText: string,
  lyrics: string,
): string {
  const preset = presetById(styleId);
  const direction = hiddenStyleDirection(styleId, customText);
  const text = [
    `Genre: ${preset?.label ?? "Custom"}.`,
    direction,
    lyrics.trim() ? `Lyrics:\n${lyrics.trim()}` : "No lyric sheet was typed.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return text.length >= 40 ? text : `${text}\nHold one visual world across every shot.`;
}
