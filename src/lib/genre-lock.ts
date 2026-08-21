/**
 * Genre lock for Hybrid Engine 1.0 (minimax/music-2.6).
 *
 * MiniMax blends genres when it receives a loose tag soup ("outlaw country,
 * gritty, male vocal, 110 bpm"). It follows a plain descriptive sentence far
 * more faithfully, so every request is reformatted into a fixed template that
 * names the *exact* style the user asked for — sub-genre included — and spells
 * out its sonic blueprint:
 *
 *   A [Mood] [Sub-genre] song. [Vocal Style] vocals.
 *   Core instrumentation: [blueprint]. Pacing: [tempo/groove].
 *   Strictly authentic [Sub-genre] production. No crossover elements from
 *   other genres. [negative constraints]
 *
 * Matching is specificity-first: the longest alias wins, so "outlaw country"
 * beats "country", "amapiano" beats "afrobeats", and "heavy rock" beats
 * "rock". That keeps sub-genres from collapsing into a generic parent
 * template.
 */

export type GenreRule = {
  /** Canonical style name used inside the sentence template. */
  label: string;
  /** Lower-case aliases matched against the user's style text. */
  match: string[];
  /** Signature instruments / production palette for this exact style. */
  instrumentation: string;
  /** Tempo range and rhythmic feel. */
  tempo: string;
  /** Negative constraints appended for this style. */
  negatives: string;
  /** True when the style is legitimately electronic/synth-led. */
  electronic?: boolean;
};

/**
 * Flat list of styles, sub-genres included. Order only breaks ties between
 * aliases of identical length; specificity (longest alias) decides first.
 */
export const GENRE_RULES: GenreRule[] = [
  // ---------------------------------------------------------------- Country
  {
    label: "Outlaw Country",
    match: ["outlaw country", "outlaw"],
    instrumentation:
      "telecaster twang, dobro and pedal steel, upright or thumping electric bass, brushed shuffle drums, harmonica",
    tempo: "mid-tempo 90-115 BPM two-step shuffle with a loose live-room feel",
    negatives:
      "raw honky-tonk production, no pop gloss, no modern rock guitars, no drum machines, no auto-tune",
  },
  {
    label: "Bluegrass",
    match: ["bluegrass", "newgrass"],
    instrumentation:
      "banjo rolls, fiddle, mandolin chop, flat-top acoustic guitar, upright bass, high-lonesome harmonies",
    tempo: "brisk 120-160 BPM acoustic drive, no drum kit",
    negatives: "purely acoustic string band, no electric guitars, no drums, no synths",
  },
  {
    label: "Honky-Tonk Country",
    match: ["honky tonk", "honky-tonk"],
    instrumentation: "pedal steel, fiddle, barroom piano, telecaster, walking bass, snare shuffle",
    tempo: "100-130 BPM barroom shuffle",
    negatives: "traditional country production, no pop, no rock distortion, no electronic drums",
  },
  {
    label: "Americana",
    match: ["americana", "alt-country", "alt country"],
    instrumentation: "acoustic and baritone guitars, lap steel, organ pads, brushed drums, warm upright bass",
    tempo: "80-110 BPM rootsy sway",
    negatives: "organic roots production, no pop synths, no trap drums, no metal guitars",
  },
  {
    label: "Country",
    match: ["country", "modern country", "country pop"],
    instrumentation: "acoustic guitar, pedal steel, telecaster licks, live drums, warm bass, hand claps",
    tempo: "90-120 BPM steady backbeat",
    negatives: "country instrumentation up front, no EDM drops, no metal guitars, no trap hi-hats",
  },
  // ------------------------------------------------------------------- Rock
  {
    label: "Nu-Metal",
    match: ["nu-metal", "nu metal", "numetal"],
    instrumentation: "downtuned 7-string riffs, syncopated live drums, scratchy samples, heavy bass",
    tempo: "85-110 BPM half-time groove",
    negatives: "downtuned and percussive, no pop gloss, no country, no EDM drops",
  },
  {
    label: "Rap-Rock",
    match: ["rap-rock", "rap rock", "rapcore"],
    instrumentation: "chunky distorted riffs, breakbeat-leaning live drums, slap bass, turntable accents",
    tempo: "90-110 BPM head-nod groove",
    negatives: "guitar-driven with rapped verses, no pop chorus gloss, no country, no EDM",
  },
  {
    label: "Metalcore",
    match: ["metalcore", "deathcore"],
    instrumentation: "palm-muted drop-tuned riffs, double-kick blasts, breakdowns, screamed and sung layers",
    tempo: "150-190 BPM with half-time breakdowns",
    negatives: "extreme metal production, no pop, no country, no dance beats",
  },
  {
    label: "Thrash Metal",
    match: ["thrash", "thrash metal", "speed metal"],
    instrumentation: "fast downpicked riffs, galloping bass, double-kick drums, shredding solos",
    tempo: "170-210 BPM relentless drive",
    negatives: "raw aggressive metal, no pop production, no country, no electronic beats",
  },
  {
    label: "Doom Metal",
    match: ["doom", "doom metal", "sludge", "stoner metal"],
    instrumentation: "massive fuzz guitars, sluggish drums, droning bass, cavernous reverb",
    tempo: "55-80 BPM crushing slow groove",
    negatives: "slow and heavy, no pop, no country, no fast dance beats",
  },
  {
    label: "Death Metal",
    match: ["death metal", "black metal"],
    instrumentation: "tremolo-picked riffs, blast beats, growled vocals, dense low-end",
    tempo: "180-240 BPM extreme intensity",
    negatives: "extreme metal, no pop, no country, no clean radio production",
  },
  {
    label: "Metal",
    match: ["metal", "heavy metal"],
    instrumentation: "high-gain twin guitars, driving double-kick drums, thick bass, guitar solo",
    tempo: "120-170 BPM aggressive drive",
    negatives: "heavy distorted guitars, no pop production, no country, no dance beats",
  },
  {
    label: "Heavy Rock",
    match: ["heavy rock", "hard rock", "arena rock"],
    instrumentation: "thick riffing electric guitars, punchy live drum kit, driving bass, arena reverb, guitar solo",
    tempo: "115-145 BPM four-on-the-floor rock backbeat",
    negatives: "live band energy, no pop synths, no country twang, no trap hi-hats, no EDM drops",
  },
  {
    label: "Classic Rock",
    match: ["classic rock", "southern rock", "blues rock"],
    instrumentation: "vintage overdriven guitars, hammond organ, live drums, warm bass, slide guitar",
    tempo: "100-130 BPM swaggering backbeat",
    negatives: "analog 70s rock production, no modern pop, no electronic drums",
  },
  {
    label: "Grunge",
    match: ["grunge"],
    instrumentation: "muddy fuzz guitars, loose live drums, gritty bass, quiet-loud dynamics",
    tempo: "90-125 BPM sludgy backbeat",
    negatives: "raw 90s production, no pop gloss, no country, no synths",
  },
  {
    label: "Rock",
    match: ["rock", "alt rock", "alternative rock", "indie rock"],
    instrumentation: "electric guitars, live drum kit, bass guitar, room-mic ambience",
    tempo: "110-140 BPM straight backbeat",
    negatives: "live band instrumentation, no pop synths, no country twang, no trap hi-hats",
  },
  {
    label: "Pop Punk",
    match: ["pop punk", "pop-punk", "skate punk"],
    instrumentation: "bright distorted power chords, fast snare-driven drums, melodic bass, gang vocals",
    tempo: "160-190 BPM fast four-on-the-floor",
    negatives: "punk energy, no country, no electronic beats, no trap drums",
  },
  {
    label: "Punk",
    match: ["punk", "hardcore punk", "garage punk"],
    instrumentation: "raw buzzsaw guitars, hammering drums, driving bass, shouted backing vocals",
    tempo: "170-200 BPM relentless",
    negatives: "raw fast guitars, no polished pop production, no country, no electronic beats",
  },
  {
    label: "Industrial",
    match: ["industrial", "ebm", "industrial metal"],
    instrumentation: "mechanical drum machines, distorted synth bass, metallic percussion, processed guitars",
    tempo: "110-135 BPM machine-locked pulse",
    negatives: "mechanical and abrasive, no country, no pop chorus gloss, no acoustic folk",
    electronic: true,
  },
  // --------------------------------------------------------------- Hip-Hop
  {
    label: "Drill",
    match: ["drill", "uk drill", "ny drill"],
    instrumentation: "sliding 808 bass, skittering hi-hat triplets, dark sparse melodies",
    tempo: "138-146 BPM half-time feel",
    negatives: "dark drill production, no rock guitars, no country, no EDM festival drops",
  },
  {
    label: "Trap",
    match: ["trap"],
    instrumentation: "booming 808s, rolling hi-hats, snappy claps, cinematic minor keys",
    tempo: "130-150 BPM half-time groove",
    negatives: "808s and hi-hat rolls, no rock guitars, no country, no EDM festival drops",
  },
  {
    label: "Boom Bap Hip-Hop",
    match: ["boom bap", "boom-bap", "90s hip hop"],
    instrumentation: "dusty sampled drum breaks, chopped soul samples, upright-style bass, vinyl crackle, scratches",
    tempo: "85-95 BPM swung head-nod groove",
    negatives: "sample-based golden-era production, no rock guitars, no country, no EDM",
  },
  {
    label: "Hip-Hop",
    match: ["hip-hop", "hip hop", "rap"],
    instrumentation: "hard drum programming, deep bass, melodic sample chops, rhythmic ad-libs",
    tempo: "85-100 BPM rhythmic pocket",
    negatives: "sampled drums and bass, no rock guitars, no country, no pop-EDM chorus",
  },
  // ------------------------------------------------------------ Soul family
  {
    label: "Neo-Soul",
    match: ["neo-soul", "neo soul"],
    instrumentation: "rhodes keys, jazzy extended chords, laid-back live drums, fretless-leaning bass",
    tempo: "70-90 BPM behind-the-beat pocket",
    negatives: "warm organic soul production, no country, no metal guitars, no EDM drops",
  },
  {
    label: "R&B",
    match: ["r&b", "rnb", "contemporary r&b"],
    instrumentation: "silky keys, finger-snap percussion, deep sub bass, layered harmony stacks",
    tempo: "70-95 BPM smooth groove",
    negatives: "smooth soulful production, no country, no metal guitars, no EDM drops",
  },
  {
    label: "Soul",
    match: ["soul", "motown", "northern soul"],
    instrumentation: "horn section, hammond organ, tight live drums, melodic bass, tambourine",
    tempo: "95-120 BPM vintage groove",
    negatives: "vintage soul production, no country, no metal, no trap drums",
  },
  {
    label: "Funk",
    match: ["funk", "p-funk", "disco funk"],
    instrumentation: "syncopated clav and wah guitar, slap bass, tight drums, punchy horn stabs",
    tempo: "100-120 BPM on-the-one groove",
    negatives: "live funk band, no country, no metal, no trap drums",
  },
  {
    label: "Gospel",
    match: ["gospel", "worship", "spiritual"],
    instrumentation: "hammond organ, grand piano, choir stacks, tambourine, live gospel drums",
    tempo: "70-95 BPM swelling build",
    negatives: "choir and organ led, no secular pop gloss, no metal, no trap drums",
  },
  {
    label: "Blues",
    match: ["blues", "delta blues", "chicago blues"],
    instrumentation: "slide and bent-note guitars, harmonica, shuffle drums, walking bass",
    tempo: "70-110 BPM 12-bar shuffle",
    negatives: "traditional blues instrumentation, no pop production, no electronic beats",
  },
  {
    label: "Jazz",
    match: ["jazz", "swing", "bebop", "lounge", "big band"],
    instrumentation: "acoustic piano, upright bass, brushed kit, muted trumpet and saxophone",
    tempo: "swung 90-160 BPM with live dynamics",
    negatives: "acoustic jazz instrumentation, no pop synths, no rock distortion, no trap drums",
  },
  {
    label: "Folk",
    match: ["folk", "acoustic", "singer-songwriter", "indie folk"],
    instrumentation: "fingerpicked acoustic guitar, upright bass, light brushes, mandolin, close-mic vocal",
    tempo: "70-105 BPM gentle organic pulse",
    negatives: "acoustic and organic, no pop synths, no heavy distortion, no electronic beats",
  },
  // --------------------------------------------------------- Caribbean/Afro
  {
    label: "Dancehall",
    match: ["dancehall", "bashment"],
    instrumentation: "digital riddim drums, heavy sub bass, staccato synth stabs, percussion fills",
    tempo: "95-105 BPM syncopated riddim",
    negatives: "authentic dancehall riddim, no rock distortion, no country, no EDM drops",
  },
  {
    label: "Dub Reggae",
    match: ["dub"],
    instrumentation: "deep bass, spring reverb and tape delay throws, skanking guitar, one-drop drums",
    tempo: "70-90 BPM spacious one-drop",
    negatives: "dub mixing aesthetics, no rock distortion, no country, no EDM",
  },
  {
    label: "Reggae",
    match: ["reggae", "roots reggae", "ska", "rocksteady"],
    instrumentation: "offbeat skank guitar, bubbling organ, one-drop drums, melodic deep bass, hand percussion",
    tempo: "70-95 BPM laid-back one-drop",
    negatives: "authentic reggae riddim, no rock distortion, no country twang, no EDM drops",
  },
  {
    label: "Amapiano",
    match: ["amapiano", "piano house", "private school amapiano"],
    instrumentation: "log drum bass, airy jazzy piano chords, shakers and rim clicks, wide pads, vocal chops",
    tempo: "112-118 BPM shuffling four-on-the-floor with log drum syncopation",
    negatives:
      "authentic South African amapiano groove, no country, no rock guitars, no EDM festival drops, no trap 808s",
    electronic: true,
  },
  {
    label: "Afrobeats",
    match: ["afrobeats", "afro-pop", "afropop", "afro pop"],
    instrumentation: "log and talking drums, shakers, bright guitar riffs, warm synth bass, layered percussion",
    tempo: "100-110 BPM syncopated dance pocket",
    negatives: "authentic African percussion and groove, no country, no metal, no EDM festival drops",
  },
  {
    label: "Afrobeat",
    match: ["afrobeat", "fela"],
    instrumentation: "horn section, interlocking guitars, congas and shekere, organ, extended live groove",
    tempo: "100-120 BPM polyrhythmic live band",
    negatives: "classic Fela-style live afrobeat, no synth pop, no country, no trap drums",
  },
  {
    label: "Reggaeton",
    match: ["reggaeton", "latin trap", "perreo"],
    instrumentation: "dembow drum pattern, deep bass, latin percussion, synth plucks",
    tempo: "90-100 BPM dembow",
    negatives: "authentic dembow groove, no rock guitars, no country, no house four-on-the-floor",
  },
  {
    label: "Latin Pop",
    match: ["latin pop", "salsa", "bachata", "cumbia"],
    instrumentation: "nylon guitar, congas and timbales, piano montuno, brass accents",
    tempo: "95-120 BPM latin clave groove",
    negatives: "authentic latin instrumentation, no metal guitars, no country, no EDM drops",
  },
  // ----------------------------------------------------------------- K/Pop
  {
    label: "Synth-Pop",
    match: ["synth-pop", "synthpop", "synthwave", "retrowave", "darksynth"],
    instrumentation: "analog synth leads, gated reverb drums, neon bass arpeggios, shimmering pads",
    tempo: "100-125 BPM retro pulse",
    negatives: "retro synth production, no country, no metal guitars, no acoustic folk",
    electronic: true,
  },
  {
    label: "Pop",
    match: ["pop", "dance pop", "power pop", "electropop"],
    instrumentation: "polished synths and keys, programmed drums, tight bass, layered chorus harmonies",
    tempo: "100-125 BPM radio-ready groove",
    negatives: "clean pop production, no country twang, no heavy metal, no extreme distortion",
  },
  {
    label: "Cinematic Orchestral",
    match: ["cinematic", "orchestral", "epic score", "soundtrack", "trailer music"],
    instrumentation: "full string sections, brass swells, taiko and hybrid percussion, choir, piano",
    tempo: "70-100 BPM building cinematic arc",
    negatives: "orchestral scoring, no pop vocal production, no country, no dance beats",
  },
  // ------------------------------------------------------------- Electronic
  {
    label: "Drum and Bass",
    match: ["drum and bass", "dnb", "d&b", "jungle", "liquid dnb"],
    instrumentation: "chopped amen breaks, reese sub bass, atmospheric pads, filtered stabs",
    tempo: "172-176 BPM breakbeat",
    negatives: "fast breakbeat production, no country, no rock band, no half-time trap",
    electronic: true,
  },
  {
    label: "House",
    match: ["house", "deep house", "tech house", "afro house"],
    instrumentation: "four-on-the-floor kick, offbeat hats, filtered chords, rolling bassline",
    tempo: "120-126 BPM steady four-on-the-floor",
    negatives: "club house production, no country, no rock guitars, no trap 808s",
    electronic: true,
  },
  {
    label: "Techno",
    match: ["techno", "minimal techno", "industrial techno"],
    instrumentation: "driving analog kick, hypnotic sequences, metallic percussion, dark atmospheres",
    tempo: "130-140 BPM relentless pulse",
    negatives: "hypnotic techno production, no country, no rock band, no pop chorus",
    electronic: true,
  },
  {
    label: "Electronic",
    match: ["electronic", "edm", "electronica", "dubstep", "trance", "future bass"],
    instrumentation: "layered synths, programmed drums, sidechained pads, sub bass",
    tempo: "120-140 BPM electronic drive",
    negatives: "fully electronic production, no country twang, no live rock band, no acoustic folk",
    electronic: true,
  },
  {
    label: "Lo-Fi",
    match: ["lo-fi", "lofi", "chillhop"],
    instrumentation: "dusty drums, jazzy rhodes chords, vinyl noise, mellow bass",
    tempo: "70-90 BPM relaxed swing",
    negatives: "lo-fi texture, no loud rock guitars, no EDM drops, no country",
    electronic: true,
  },
  {
    label: "Electro Swing",
    match: ["electro swing", "electroswing"],
    instrumentation: "swing horn samples, upright bass, four-on-the-floor kick, vinyl crackle, charleston bounce",
    tempo: "118-128 BPM swung club groove",
    negatives: "vintage swing samples over club drums, no country, no metal, no trap 808s",
    electronic: true,
  },
];

/** Mood adjectives recognised in the user's own words, most specific first. */
const MOOD_WORDS = [
  "dark",
  "aggressive",
  "angry",
  "melancholic",
  "sad",
  "heartbroken",
  "hopeful",
  "uplifting",
  "triumphant",
  "anthemic",
  "gritty",
  "raw",
  "haunting",
  "eerie",
  "romantic",
  "nostalgic",
  "dreamy",
  "chill",
  "laid-back",
  "energetic",
  "upbeat",
  "playful",
  "defiant",
  "reflective",
  "somber",
  "epic",
  "moody",
  "soulful",
];

const DEFAULT_MOOD = "emotive";
const DEFAULT_GENRE = "contemporary";
const DEFAULT_VOCAL = "lead";

function has(text: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

/**
 * Most specific style rule present in the text. The longest matching alias
 * wins so sub-genres ("outlaw country", "amapiano", "heavy rock") never
 * collapse into their broader parent.
 */
export function detectGenre(text: string): GenreRule | null {
  const lower = text.toLowerCase();
  let best: GenreRule | null = null;
  let bestLength = 0;
  for (const rule of GENRE_RULES) {
    for (const alias of rule.match) {
      if (alias.length > bestLength && has(lower, alias)) {
        best = rule;
        bestLength = alias.length;
      }
    }
  }
  return best;
}

/** True when the detected style is legitimately synth/electronic-led. */
export function isElectronicStyle(text: string): boolean {
  return detectGenre(text)?.electronic === true;
}

/** First recognised mood adjective in the style text. */
export function detectMood(text: string): string | null {
  const lower = text.toLowerCase();
  return MOOD_WORDS.find((word) => has(lower, word)) ?? null;
}

/**
 * Vocal descriptor. The studio encodes chosen presets as `vocals: a, b, c`;
 * anything else falls back to scanning for a "... vocal" phrase.
 */
export function detectVocalStyle(text: string): string | null {
  const tagged = /vocals?\s*:\s*([^|\n]+)/i.exec(text);
  const source = tagged?.[1] ?? text;
  const parts = source
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((p) => p.replace(/\bvocals?\b/gi, "").replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);
  if (tagged && parts.length) return parts.join(", ").toLowerCase();
  const loose = /\b([a-z][a-z\- ]{2,30}?)\s+vocals?\b/i.exec(text);
  return loose?.[1]?.trim().toLowerCase() ?? null;
}

/** Bracketed control directives ([Tempo: …]) are preserved verbatim. */
function splitDirectives(text: string): { directives: string; rest: string } {
  const directives = text.match(/\[[^\]]+\]/g) ?? [];
  return { directives: directives.join(" "), rest: text.replace(/\[[^\]]+\]/g, " ") };
}

/** Words already expressed by the sentence template, dropped from the tail. */
function tailDetails(rest: string, used: string[]): string {
  const usedLower = used.map((u) => u.toLowerCase());
  const segments = rest
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^vocals?\s*:/i.test(s))
    .filter((s) => {
      const lower = s.toLowerCase();
      return !usedLower.some((u) => u && (lower === u || lower.includes(u)));
    });
  return Array.from(new Set(segments)).join(", ");
}

/** True when the user already pinned a tempo, so the blueprint pacing yields. */
function hasExplicitTempo(text: string): boolean {
  return /\b\d{2,3}\s*bpm\b/i.test(text);
}

/**
 * Rewrites a loose style/tag string into the fixed descriptive template with
 * the detected style's instrumentation blueprint, pacing and negative
 * constraints, so the engine reproduces the exact requested sub-genre.
 */
export function buildGenreLockedPrompt(style: string, fallbackBrief = ""): string {
  const source = [style, fallbackBrief].filter(Boolean).join(" | ");
  const { directives, rest } = splitDirectives(source);

  const rule = detectGenre(rest);
  const genre = rule?.label ?? DEFAULT_GENRE;
  const mood = detectMood(rest) ?? DEFAULT_MOOD;
  const vocal = detectVocalStyle(rest) ?? DEFAULT_VOCAL;

  const article = /^[aeiou]/i.test(mood) ? "An" : "A";
  const sentence =
    `${article} ${mood} ${genre} song. ${vocal} vocals. ` +
    `Strictly authentic ${genre} production and arrangement. ` +
    `No crossover elements from other genres.`;

  const blueprint = rule ? `Core instrumentation: ${rule.instrumentation}.` : "";
  const pacing = rule && !hasExplicitTempo(source) ? `Pacing: ${rule.tempo}.` : "";
  const negatives = rule ? `${rule.negatives}.` : "";
  const details = tailDetails(rest, [
    genre,
    mood,
    ...vocal.split(",").map((v) => v.trim()),
    ...(rule?.match ?? []),
  ]);

  return [sentence, blueprint, pacing, negatives, details, directives]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 6000);
}
