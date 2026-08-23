/**
 * Universal Style Prompt Optimizer — 100K Prompt Book 5-layer architecture.
 *
 * Layers:
 *   [Genre / Sub-genre], [BPM & Groove], [Mood/Energy],
 *   [Lead Hook Instrument], [Rhythm Bed Instrument], [Atmosphere]
 *
 * Serialized as a single AIMusicAPI `tags` string:
 *   "{genre}, {bpm} BPM, {mood}, {lead} carry the hook while {bed} fill the space[, {atmosphere}]"
 */

import { detectGenre, detectMood } from "@/lib/genre-lock";

export type StyleLayerPack = {
  id: string;
  /** "Alternative Rock, grunge revival" — genre + sub-genre in one clause. */
  genreSub: string;
  defaultBpm: number;
  mood: string;
  leadHook: string;
  rhythmBed: string;
  /** Optional trailing atmosphere / spatial cue. */
  atmosphere?: string;
  /** Gate 4 formant / delivery phrase when a custom voice is bound. */
  vocalDelivery: string;
  match: string[];
};

/**
 * Priority packs for common freeform seeds. Longer aliases win via
 * `resolveStylePack` so "alternative rock" beats bare "rock".
 */
export const STYLE_LAYER_PACKS: StyleLayerPack[] = [
  {
    id: "grunge-alt-rock",
    genreSub: "Alternative Rock, grunge revival",
    defaultBpm: 101,
    mood: "raw dynamic mood",
    leadHook: "overdriven electric guitar leads",
    rhythmBed: "heavy live punchy drums and distorted bass",
    atmosphere: "dry garage room grit",
    vocalDelivery:
      "raw raspy sung-shouted delivery matching the guitar grit, preserved formant texture",
    match: [
      "grunge revival",
      "alternative rock",
      "alt rock",
      "alt-rock",
      "grunge",
      "90s rock",
    ],
  },
  {
    id: "boom-bap",
    genreSub: "Boom Bap, east coast 90s",
    defaultBpm: 92,
    mood: "gritty underground energy",
    leadHook: "vinyl sample chops",
    rhythmBed: "punchy kick-snare and walking bassline",
    atmosphere: "dusty vinyl crackle",
    vocalDelivery:
      "gritty underground rap delivery with vinyl-era formant texture",
    match: ["boom bap", "boom-bap", "east coast 90s", "90s hip hop", "90s hip-hop"],
  },
  {
    id: "cyberpunk-darksynth",
    genreSub: "Cyberpunk, darksynth",
    defaultBpm: 120,
    mood: "adrenalized mood",
    leadHook: "alarm-like synth leads",
    rhythmBed: "distorted bass and cybernetic risers",
    atmosphere: "neon nocturnal haze",
    vocalDelivery:
      "processed cybernetic sung delivery with analog formant sheen",
    match: ["cyberpunk", "darksynth", "synthwave", "retrowave", "outrun"],
  },
  {
    id: "hard-rock",
    genreSub: "Hard Rock, arena drive",
    defaultBpm: 128,
    mood: "high-voltage swagger",
    leadHook: "thick distorted guitar riffs",
    rhythmBed: "driving live drums and thick bass",
    atmosphere: "arena room reverb",
    vocalDelivery: "aggressive raw shouted-sung delivery, preserved formant texture",
    match: ["hard rock", "heavy rock", "arena rock", "heavy metal", "metal"],
  },
  {
    id: "trap",
    genreSub: "Trap, modern 808",
    defaultBpm: 140,
    mood: "dark cinematic energy",
    leadHook: "minor-key melodic stabs",
    rhythmBed: "booming 808s and rolling hi-hats",
    atmosphere: "wide night-drive space",
    vocalDelivery: "rhythmic rap delivery with tight modern formant texture",
    match: ["trap", "drill"],
  },
  {
    id: "outlaw-country",
    genreSub: "Outlaw Country, southern grit",
    defaultBpm: 108,
    mood: "dusty storytelling mood",
    leadHook: "telecaster and slide guitar leads",
    rhythmBed: "live shuffle drums and thumping bass",
    atmosphere: "roadhouse room air",
    vocalDelivery: "raspy baritone storytelling sung delivery, dry room formant",
    match: ["outlaw country", "southern rock", "country", "americana"],
  },
  {
    id: "acoustic-folk",
    genreSub: "Acoustic Folk, unplugged",
    defaultBpm: 88,
    mood: "intimate warm mood",
    leadHook: "fingerpicked acoustic guitar",
    rhythmBed: "light brushes and upright bass",
    atmosphere: "close-mic room tone",
    vocalDelivery: "intimate close-mic sung delivery, natural formant texture",
    match: ["acoustic", "folk", "singer-songwriter", "unplugged"],
  },
  {
    id: "house",
    genreSub: "House, club four-on-the-floor",
    defaultBpm: 124,
    mood: "euphoric dance energy",
    leadHook: "filtered chord stabs",
    rhythmBed: "four-on-the-floor kick and rolling bassline",
    atmosphere: "club haze and sidechain pump",
    vocalDelivery: "melodic club vocal delivery with polished formant texture",
    match: ["house", "deep house", "tech house", "techno", "edm"],
  },
];

const DEFAULT_PACK: StyleLayerPack = {
  id: "generic",
  genreSub: "Contemporary, hybrid production",
  defaultBpm: 110,
  mood: "focused driving energy",
  leadHook: "melodic lead motifs",
  rhythmBed: "punchy drums and supportive bass",
  atmosphere: "polished studio depth",
  vocalDelivery: "natural lead vocal delivery, preserved formant texture for stem protection",
  match: [],
};

function hasAlias(haystack: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/** Most specific style pack for freeform + chip text. */
export function resolveStylePack(text: string): StyleLayerPack {
  const lower = text.toLowerCase();
  let best: StyleLayerPack | null = null;
  let bestLength = 0;
  for (const pack of STYLE_LAYER_PACKS) {
    for (const alias of pack.match) {
      if (alias.length > bestLength && hasAlias(lower, alias)) {
        best = pack;
        bestLength = alias.length;
      }
    }
  }
  if (best) return best;

  const rule = detectGenre(text);
  if (!rule) return { ...DEFAULT_PACK, genreSub: text.trim() || DEFAULT_PACK.genreSub };

  // Map genre-lock labels onto closest pack instrumentation when no explicit pack hit.
  const mapped =
    STYLE_LAYER_PACKS.find((p) =>
      p.match.some((m) => rule.match.some((alias) => alias.includes(m) || m.includes(alias))),
    ) ?? null;

  if (mapped) {
    return {
      ...mapped,
      genreSub: `${rule.label}, ${mapped.genreSub.split(",").slice(1).join(",").trim() || "signature cut"}`,
    };
  }

  const [lead, ...rest] = rule.instrumentation.split(",").map((s) => s.trim());
  const bed = rest.slice(0, 2).join(" and ") || "supporting rhythm section";
  const bpmMatch = /(\d+)\s*[-–]\s*(\d+)\s*BPM/i.exec(rule.tempo);
  const defaultBpm = bpmMatch
    ? Math.round((Number(bpmMatch[1]) + Number(bpmMatch[2])) / 2)
    : DEFAULT_PACK.defaultBpm;

  return {
    id: `lock-${rule.label.toLowerCase().replace(/\s+/g, "-")}`,
    genreSub: rule.label,
    defaultBpm,
    mood: detectMood(text) ? `${detectMood(text)} mood` : DEFAULT_PACK.mood,
    leadHook: lead || DEFAULT_PACK.leadHook,
    rhythmBed: bed,
    atmosphere: rule.electronic ? "synthetic spatial width" : "live room depth",
    vocalDelivery: DEFAULT_PACK.vocalDelivery,
    match: rule.match,
  };
}

export function isFiveLayerStylePrompt(text: string | null | undefined): boolean {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return false;
  return /carry the hook while/i.test(value) && /\d+\s*BPM\b/i.test(value);
}

function extractBpm(text: string): number | null {
  const m = /(\d{2,3})\s*BPM\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractGenreSub(text: string, pack: StyleLayerPack): string {
  // Prefer text before the first BPM clause when the artist already named a style.
  const beforeBpm = text.split(/\d{2,3}\s*BPM\b/i)[0]?.trim().replace(/,\s*$/, "") ?? "";
  if (beforeBpm && beforeBpm.length >= 3 && !/carry the hook/i.test(beforeBpm)) {
    // If they only typed a short seed ("grunge"), expand to the pack genreSub.
    const tokens = beforeBpm.split(",").map((t) => t.trim()).filter(Boolean);
    if (tokens.length >= 2) return tokens.slice(0, 2).join(", ");
    if (tokens.length === 1 && tokens[0].toLowerCase() === pack.genreSub.split(",")[0].trim().toLowerCase()) {
      return pack.genreSub;
    }
    // Short freeform seed → pack's full genre/sub pair when pack matched that seed.
    if (pack.id !== "generic" && pack.match.some((m) => hasAlias(beforeBpm, m))) {
      return pack.genreSub;
    }
    if (tokens.length === 1 && tokens[0].length < 40) {
      // Keep artist wording as genre, pack sub-genre if available.
      const sub = pack.genreSub.split(",")[1]?.trim();
      return sub ? `${tokens[0]}, ${sub}` : tokens[0];
    }
  }
  return pack.genreSub;
}

function extractMoodPhrase(text: string, moodHint: string | undefined, pack: StyleLayerPack): string {
  const hint = moodHint?.trim();
  if (hint) {
    return /mood|energy|vibe/i.test(hint) ? hint : `${hint} mood`;
  }
  const moodWord = detectMood(text);
  if (moodWord) return `${moodWord} mood`;
  const existing = text.match(
    /\b((?:raw|gritty|adrenalized|dark|bright|intimate|euphoric|aggressive|warm|dusty)[^,]{0,40}?(?:mood|energy|vibe))\b/i,
  );
  if (existing?.[1]) return existing[1].trim();
  return pack.mood;
}

export type FiveLayerParts = {
  genreSub: string;
  bpm: number;
  mood: string;
  leadHook: string;
  rhythmBed: string;
  atmosphere?: string;
};

/** Serialize the 5-layer architecture into the Prompt Book tags sentence. */
export function formatFiveLayerStyle(parts: FiveLayerParts): string {
  const bpm = Math.round(Math.min(300, Math.max(40, parts.bpm)));
  const core = [
    parts.genreSub.trim(),
    `${bpm} BPM`,
    parts.mood.trim(),
    `${parts.leadHook.trim()} carry the hook while ${parts.rhythmBed.trim()} fill the space`,
  ];
  const atmosphere = parts.atmosphere?.trim();
  if (atmosphere && !core.join(" ").toLowerCase().includes(atmosphere.toLowerCase())) {
    core.push(atmosphere);
  }
  return core.filter(Boolean).join(", ");
}

export type OptimizeStyleInput = {
  /** Freeform Style Prompt box (+ optional chip blend already joined by caller). */
  text: string;
  bpm?: number;
  mood?: string;
  /** Genre chips joined, e.g. "Rock, Grunge". */
  genreHint?: string;
  hasCustomVoice?: boolean;
  vocalStyle?: string;
};

/**
 * Structures any freeform / chip seed into the 5-layer Prompt Book format.
 * Already-optimized strings are refreshed (BPM / formant) without inventing a new genre.
 */
export function optimizeStylePrompt(input: OptimizeStyleInput): string {
  const seed = [input.genreHint, input.text].filter((s) => typeof s === "string" && s.trim()).join(", ").trim();
  if (!seed && input.bpm == null) return "";

  const pack = resolveStylePack(seed || packFallbackSeed(input));
  const bpm = extractBpm(seed) ?? (typeof input.bpm === "number" ? input.bpm : pack.defaultBpm);

  let genreSub: string;
  let mood: string;
  let leadHook: string;
  let rhythmBed: string;
  let atmosphere: string | undefined;

  if (isFiveLayerStylePrompt(seed)) {
    // Keep artist-authored layers; only normalize BPM if the studio slider differs.
    const hookMatch =
      /,\s*(.+?)\s+carry the hook while\s+(.+?)\s+fill the space(?:,\s*(.+))?$/i.exec(seed);
    genreSub = extractGenreSub(seed, pack);
    mood = extractMoodPhrase(seed, input.mood, pack);
    leadHook = hookMatch?.[1]?.trim() || pack.leadHook;
    rhythmBed = hookMatch?.[2]?.trim() || pack.rhythmBed;
    atmosphere = hookMatch?.[3]?.trim() || pack.atmosphere;
  } else {
    genreSub = extractGenreSub(seed || pack.genreSub, pack);
    mood = extractMoodPhrase(seed, input.mood, pack);
    leadHook = pack.leadHook;
    rhythmBed = pack.rhythmBed;
    atmosphere = pack.atmosphere;
  }

  let optimized = formatFiveLayerStyle({
    genreSub,
    bpm,
    mood,
    leadHook,
    rhythmBed,
    atmosphere,
  });

  if (input.hasCustomVoice) {
    optimized = appendFormantVocalDelivery(optimized, {
      hasCustomVoice: true,
      vocalStyle: input.vocalStyle,
      styleHint: seed,
    });
  }

  return optimized;
}

function packFallbackSeed(input: OptimizeStyleInput): string {
  return [input.genreHint, input.mood].filter(Boolean).join(", ") || "contemporary";
}

/**
 * Gate 4 formant & stem protection — append genre-matched vocal delivery when
 * a custom voice sample is bound so Fish cloning follows the texture of the bed.
 */
export function appendFormantVocalDelivery(
  style: string,
  opts: {
    hasCustomVoice: boolean;
    vocalStyle?: string;
    styleHint?: string;
  },
): string {
  if (!opts.hasCustomVoice) return style;
  const base = style.trim();
  if (!base) return base;

  const pack = resolveStylePack(opts.styleHint || base);
  const delivery = (opts.vocalStyle?.trim() || pack.vocalDelivery).trim();
  if (!delivery) return base;

  const lower = base.toLowerCase();
  if (lower.includes(delivery.toLowerCase())) return base;
  // Already has a formant / delivery protection clause.
  if (/\bformant\b/i.test(base) && /\bdelivery\b/i.test(base)) return base;

  return `${base}, ${delivery}`;
}

/** Build Gate 1 `tags` from chips + freeform, optionally formant-protected. */
export function buildGate1StyleTags(input: {
  styleChips: string;
  stylePrompt: string;
  fallback?: string;
  hasCustomVoice?: boolean;
  vocalStyle?: string;
}): string {
  const raw =
    [input.styleChips.trim(), input.stylePrompt.trim()].filter(Boolean).join(", ") ||
    input.fallback?.trim() ||
    "";
  return appendFormantVocalDelivery(raw, {
    hasCustomVoice: Boolean(input.hasCustomVoice),
    vocalStyle: input.vocalStyle,
    styleHint: raw,
  });
}
