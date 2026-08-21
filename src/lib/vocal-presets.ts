/**
 * Vocal character presets and prompt compilation for the Hybrid Audio Studio.
 * Kept out of the component so the engine payload is built the same way
 * everywhere and stays easy to test.
 */

export const VOCAL_PRESETS = [
  "Aggressive Rock Vocal",
  "Melodic / Clean",
  "Rap / Delivery",
  "Heavy / Nu-Metal",
  "Female Vocal",
  "Male Vocal",
] as const;

export type VocalPreset = (typeof VOCAL_PRESETS)[number];

/** Recognised song-structure tags, so user structure survives compilation. */
const STRUCTURE_TAG = /^\s*[[(]?\s*(intro|verse|pre-?chorus|chorus|hook|bridge|refrain|outro|drop|breakdown)\s*\d*\s*[\])]?\s*:?\s*$/i;

/**
 * Normalises user lyrics: trims trailing spaces, collapses runs of blank
 * lines and rewrites bare structure words into bracketed tags the engine
 * understands (e.g. "Chorus" -> "[Chorus]").
 */
export function formatLyricBlocks(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const match = trimmed.match(STRUCTURE_TAG);
    if (match) {
      const label = trimmed.replace(/[[\]():]/g, "").trim();
      const tag = `[${label.replace(/\b\w/g, (c) => c.toUpperCase())}]`;
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push(tag);
      continue;
    }
    out.push(trimmed.trim());
  }
  return out.join("\n").trim();
}

export type PromptParts = {
  styleTags: string[];
  vocalPresets: string[];
  instrumental: boolean;
  concept?: string;
};

/**
 * Builds the single style/prompt string sent to MiniMax 2.6 — musical style
 * tags first, then the vocal character, then any free-form concept.
 */
export function compileEnginePrompt(parts: PromptParts): string {
  const segments: string[] = [];
  if (parts.styleTags.length) segments.push(parts.styleTags.join(", "));
  if (parts.instrumental) {
    segments.push("instrumental, no vocals");
  } else if (parts.vocalPresets.length) {
    segments.push(`vocals: ${parts.vocalPresets.join(", ")}`);
  }
  const concept = parts.concept?.trim();
  if (concept) segments.push(concept);
  return segments.join(" | ");
}

/** Human-readable vocal profile shown on the finished master card. */
export function vocalProfileLabel(parts: {
  instrumental: boolean;
  vocalPresets: string[];
}): string {
  if (parts.instrumental) return "Instrumental only (no vocals)";
  if (!parts.vocalPresets.length) return "Custom vocals";
  return parts.vocalPresets.join(" · ");
}

/**
 * Long, browsable catalogue of vocal styles and characters, grouped so the
 * studio dropdown can be scrolled and scanned quickly.
 */
export const VOCAL_STYLE_GROUPS: { label: string; options: string[] }[] = [
  {
    label: "Character",
    options: [
      "Androgynous Vocal",
      "Child-like Vocal",
      "Whisper Vocal",
      "Spoken Word",
      "Robotic / Vocoder Vocal",
    ],
  },
  {
    label: "Rock & metal",
    options: [
      "Aggressive Rock Vocal",
      "Arena Rock Belt",
      "Grunge Rasp",
      "Punk Shout",
      "Heavy / Nu-Metal",
      "Metalcore Scream",
      "Death Growl",
      "Black Metal Shriek",
      "Emo / Post-Hardcore",
      "Southern Rock Grit",
      "Glam Rock Wail",
    ],
  },
  {
    label: "Hip-hop & rap",
    options: [
      "Rap / Delivery",
      "Aggressive Trap Rap",
      "Melodic Rap",
      "Drill Flow",
      "Boom Bap Flow",
      "Double-Time Flow",
      "Conscious Rap",
      "Auto-Tune Rap",
      "Mumble / Laid-Back Flow",
      "Battle Rap Intensity",
      "Storytelling Rap",
    ],
  },
  {
    label: "Pop & R&B",
    options: [
      "Melodic / Clean",
      "Radio Pop Polish",
      "Airy Indie Pop",
      "Smooth R&B",
      "Neo-Soul Runs",
      "Gospel Power Vocal",
      "Soul Belter",
      "Motown Warmth",
      "K-Pop Bright",
      "Dance Pop Diva",
      "Breathy Bedroom Pop",
    ],
  },
  {
    label: "Country, folk & roots",
    options: [
      "Country Twang",
      "Outlaw Country Grit",
      "Nashville Polish",
      "Bluegrass High Lonesome",
      "Folk Storyteller",
      "Americana Warmth",
      "Blues Moan",
      "Delta Blues Rasp",
      "Gospel Choir Stack",
    ],
  },
  {
    label: "Electronic & experimental",
    options: [
      "EDM Anthem Vocal",
      "House Diva",
      "Synthwave Reverb Vocal",
      "Hyperpop Pitched Vocal",
      "Chopped & Screwed",
      "Glitch-Processed Vocal",
      "Ethereal Ambient Vocal",
      "Talkbox",
      "Megaphone / Lo-Fi Vocal",
    ],
  },
  {
    label: "World & traditional",
    options: [
      "Afrobeats Vocal",
      "Amapiano Chant",
      "Reggae Toasting",
      "Dancehall Patois",
      "Latin Pop Vocal",
      "Reggaeton Flow",
      "Flamenco Cante",
      "Bollywood Playback",
      "Arabic Melisma",
      "Baltic Folk Harmony",
      "Opera / Classical",
    ],
  },
  {
    label: "Character & emotion",
    options: [
      "Dark & Menacing",
      "Confident & Commanding",
      "Vulnerable & Intimate",
      "Hopeful & Uplifting",
      "Melancholic",
      "Playful & Cheeky",
      "Desperate & Raw",
      "Cold & Detached",
      "Triumphant Anthem",
      "Late-Night Smoky",
      "Preacher Cadence",
      "Narrator / Cinematic",
    ],
  },
  {
    label: "Texture & production",
    options: [
      "Raspy",
      "Smoky",
      "Silky Smooth",
      "Gritty & Distorted",
      "Doubled / Stacked Harmonies",
      "Choir Backing",
      "Heavy Reverb",
      "Dry & Upfront",
      "Lo-Fi Tape Vocal",
      "Wide Stereo Chorus",
      "Call & Response Adlibs",
    ],
  },
];
