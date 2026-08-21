/**
 * AI Prompt Inspirations — quick-fill presets for the studio.
 *
 * Every preset carries a balanced style string (BPM + instruments + vocal
 * timbre) and a ready-to-run track brief. Vocal tags are always appended and
 * instrumental/no-vocal phrasing is always stripped so MiniMax never returns a
 * pure instrumental beat.
 */

import { appendVocalTags, stripInstrumentalTerms } from "@/lib/vocal-prompt";

export type PromptInspiration = {
  id: string;
  label: string;
  group: string;
  /** Typical tempo shown on the chip. */
  bpm: string;
  /** Instrument + production tags. */
  instruments: string;
  /** Vocal timbre and delivery. */
  vocals: string;
  /** Ready-made track brief. */
  brief: string;
};

export const PROMPT_INSPIRATIONS: PromptInspiration[] = [
  {
    id: "electroswing",
    label: "Electroswing",
    group: "Electronic",
    bpm: "122 BPM",
    instruments:
      "electro swing, vintage remix, charleston bounce, muted trumpet samples, upright bass swing, vinyl crackle, four-on-the-floor kick",
    vocals: "male lead vocals, clear singing voice, sassy scat-inflected phrasing",
    brief:
      "Glamorous electro swing anthem — a 1920s speakeasy party crashing a modern nightclub, sung hook, defiant swagger.",
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk / Darksynth",
    group: "Electronic",
    bpm: "110 BPM",
    instruments:
      "darksynth, cyberpunk, gritty analog synth bass, gated drums, neon arpeggios, distorted pads, cinematic risers",
    vocals: "male lead vocals, clear singing voice, cold gritty baritone delivery",
    brief:
      "Neon-drenched cyberpunk anthem about running the night city rooftops, sung chorus, relentless drive.",
  },
  {
    id: "country",
    label: "Country",
    group: "Roots",
    bpm: "96 BPM",
    instruments:
      "modern country, acoustic guitar, pedal steel, slide guitar, live drums, warm bass, hand claps",
    vocals: "male lead vocals, clear singing voice, raspy baritone storytelling delivery",
    brief:
      "Dirt-road country story about coming home harder than you left, sung storytelling verses, big singalong chorus.",
  },
  {
    id: "hard-rock",
    label: "Hard Rock",
    group: "Rock",
    bpm: "138 BPM",
    instruments:
      "hard rock, distorted guitar riffs, driving live drums, thick bass, guitar solo, arena reverb",
    vocals: "male lead vocals, clear singing voice, aggressive raw shouted-sung delivery, gang chorus vocals",
    brief:
      "Arena hard rock anthem about refusing to fold, huge riff, screaming chorus, live-band energy.",
  },
  {
    id: "hip-hop",
    label: "Hip-Hop / Boom Bap",
    group: "Hip-Hop",
    bpm: "90 BPM",
    instruments:
      "boom bap hip-hop, dusty drum break, heavy 808 bass, vinyl texture, soul sample chops, punchy snare",
    vocals: "male lead vocals, clear singing voice, confident rhythmic rap delivery, sung hook",
    brief:
      "Gritty boom bap record about building an empire out of nothing, rapped verses, melodic sung hook.",
  },
  {
    id: "trap",
    label: "Trap",
    group: "Hip-Hop",
    bpm: "142 BPM",
    instruments:
      "dark trap, hard 808s, rolling hi-hats, cinematic brass stabs, sub bass, sparse minor piano",
    vocals: "male lead vocals, clear singing voice, melodic auto-tuned hook, hard-hitting rap verses",
    brief:
      "Dark cinematic trap anthem, defiant hook, late-night skyline energy.",
  },
  {
    id: "afrobeats",
    label: "Afrobeats",
    group: "World",
    bpm: "104 BPM",
    instruments:
      "afrobeats, log drum groove, shakers, bright guitar riffs, warm synth bass, percussive layers",
    vocals: "male lead vocals, clear singing voice, smooth melodic delivery, layered background harmonies",
    brief:
      "Sun-soaked afrobeats groove about celebrating a hard-won win, sung chorus, danceable pocket.",
  },
  {
    id: "gospel-soul",
    label: "Gospel / Soul",
    group: "Roots",
    bpm: "78 BPM",
    instruments:
      "gospel soul, hammond organ, live gospel drums, warm bass, grand piano, tambourine, choir stacks",
    vocals: "male lead vocals, clear singing voice, powerful soulful delivery, full choir backing vocals",
    brief:
      "Testimony-driven gospel soul record about being carried through the fire, sung lead with choir answers.",
  },
  {
    id: "synthwave-pop",
    label: "Synthwave / Pop",
    group: "Pop",
    bpm: "116 BPM",
    instruments:
      "synthwave pop, analog synth leads, gated drums, neon bass, shimmering pads, retro chorus guitar",
    vocals: "male lead vocals, clear singing voice, clean melodic tone, catchy layered chorus harmonies",
    brief:
      "Retro-future synthwave pop track about chasing headlights at midnight, huge sung chorus.",
  },
  {
    id: "cinematic-epic",
    label: "Cinematic / Epic",
    group: "Commercial",
    bpm: "88 BPM",
    instruments:
      "cinematic epic, full orchestra, taiko drums, soaring strings, brass swells, choir, hybrid trailer percussion",
    vocals: "male lead vocals, clear singing voice, commanding sung delivery, epic choir backing",
    brief:
      "Epic cinematic anthem about the last stand before dawn, sung lead over trailer-scale orchestra.",
  },
];

/** Builds the balanced, vocal-safe style string for a preset. */
export function buildStyleFromInspiration(preset: PromptInspiration): string {
  return appendVocalTags(
    stripInstrumentalTerms([preset.bpm, preset.instruments, preset.vocals].join(", ")),
  );
}

/** Builds the vocal-safe track brief for a preset. */
export function buildBriefFromInspiration(preset: PromptInspiration): string {
  return stripInstrumentalTerms(preset.brief);
}

/** Averages the BPM values of the selected presets for a blended style. */
function blendBpm(presets: PromptInspiration[]): string {
  const values = presets
    .map((p) => Number.parseInt(p.bpm, 10))
    .filter((n) => Number.isFinite(n));
  if (values.length === 0) return "";
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  return `${avg} BPM`;
}

/** De-duplicates comma separated tags, preserving order. */
function dedupeTags(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of parts.join(", ").split(",")) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out.join(", ");
}

/**
 * Blends one or more presets into a single vocal-safe style string: an averaged
 * BPM followed by the combined, de-duplicated instrument and vocal tags.
 */
export function buildStyleFromInspirations(presets: PromptInspiration[]): string {
  if (presets.length === 0) return "";
  if (presets.length === 1) return buildStyleFromInspiration(presets[0]!);
  const fusion = `${presets.map((p) => p.label).join(" x ")} fusion`;
  const tags = dedupeTags([
    blendBpm(presets),
    fusion,
    ...presets.map((p) => p.instruments),
    ...presets.map((p) => p.vocals),
  ]);
  return appendVocalTags(stripInstrumentalTerms(tags));
}

/** Blends the briefs of the selected presets into one track brief. */
export function buildBriefFromInspirations(presets: PromptInspiration[]): string {
  if (presets.length === 0) return "";
  if (presets.length === 1) return buildBriefFromInspiration(presets[0]!);
  const labels = presets.map((p) => p.label).join(" + ");
  const bodies = presets
    .map((p) => stripInstrumentalTerms(p.brief).replace(/\.$/, ""))
    .join("; ");
  return stripInstrumentalTerms(`${labels} blend — ${bodies}. Full sung lead vocal throughout.`);
}
