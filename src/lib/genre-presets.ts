/** Genre presets for the studio. Every preset carries vocal descriptors so the
 * engine never defaults to an instrumental or generic electronic beat. */

export type GenrePreset = {
  id: string;
  label: string;
  /** Style tags appended to the style field when the chip is selected. */
  tags: string;
};

export const GENRE_PRESETS: GenrePreset[] = [
  {
    id: "outlaw-country",
    label: "Outlaw Country / Southern Rock",
    tags:
      "outlaw country, southern rock, gritty acoustic and electric guitars, slide guitar, live drums, raspy baritone male lead vocal, sung storytelling delivery",
  },
  {
    id: "hard-rock",
    label: "Hard Rock / Heavy Metal",
    tags:
      "hard rock, heavy metal, driving drums, distorted guitar riffs, thick bass, aggressive raw male lead vocal, shouted-sung delivery, powerful chorus vocals",
  },
  {
    id: "boom-bap",
    label: "Hip-Hop / Boom Bap",
    tags:
      "hip-hop, boom bap, heavy bass, punchy drums, vinyl texture, rhythmic rapped lead vocal, confident lyric delivery, sung hook",
  },
  {
    id: "acoustic-folk",
    label: "Acoustic / Folk",
    tags:
      "acoustic folk, unplugged fingerpicked guitar, warm room acoustics, light percussion, intimate close-mic male lead vocal, sung melody, soft harmonies",
  },
  {
    id: "synthwave-pop",
    label: "Synthwave / Pop",
    tags:
      "synthwave pop, driving analog synths, gated drums, neon bass, clean melodic lead vocal, catchy sung chorus, layered vocal harmonies",
  },
];

/** Merges preset tags into the current style text without duplicating tags. */
export function mergeStyleTags(current: string, tags: string): string {
  const existing = current
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const lower = new Set(existing.map((t) => t.toLowerCase()));
  const additions = tags
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && !lower.has(t.toLowerCase()));
  return [...existing, ...additions].join(", ");
}

/** Removes a preset's tags from the style text when the chip is toggled off. */
export function removeStyleTags(current: string, tags: string): string {
  const drop = new Set(
    tags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  return current
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && !drop.has(t.toLowerCase()))
    .join(", ");
}
