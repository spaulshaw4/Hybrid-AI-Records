/**
 * Genre Visual Laws for the Visual Engine.
 *
 * Music videos kept drifting into neon/cyberpunk club imagery regardless of the
 * uploaded track, so every genre now has a hard rule set: which environments and
 * wardrobe are allowed, how light must physically behave, and which tropes are
 * banned outright. The laws are enforced twice — once in the shot planner, and
 * once again as a negative-prompt block on every video render call.
 */

export type GenreLaw = {
  /** Stable id sent between the planner and the render calls. */
  id: string;
  /** Human label, e.g. "Country / Americana". */
  label: string;
  /** Genre signals in the title, notes or lyrics. */
  match: RegExp;
  /** Mandatory environments. */
  environments: string;
  /** Mandatory wardrobe / styling. */
  wardrobe: string;
  /** Lighting physics the shot must obey. */
  lighting: string;
  /** Banned tropes — also injected as the negative prompt. */
  banned: string[];
  /** True when futuristic/synthetic imagery is forbidden outright. */
  grounded: boolean;
};

const NO_FUTURE = [
  "no neon lasers",
  "no neon cityscapes",
  "no cyber dancers",
  "no cyber suits",
  "no sci-fi cities",
  "no holographic tech",
  "no HUD or UI overlays",
  "no LED walls or laser stages",
  "no robots or androids",
];

const NO_STATIC = [
  "no static portrait cards",
  "no split-screen panels",
  "no photo montages",
  "no title cards or logo stings",
];

export const GENRE_LAWS: GenreLaw[] = [
  {
    id: "country",
    label: "Country / Americana",
    match:
      /\b(country|honky[- ]?tonk|bluegrass|americana|nashville|outlaw country|truck|pickup truck|dirt road|whiskey|hay ?bale|barn|cowboy|boots|banjo|fiddle|steel guitar)\b/i,
    environments:
      "open highways and dirt back roads, weathered barns and grain silos, wheat and corn fields, small-town main " +
      "streets, roadside honky-tonks and dive bars, front porches, riverbanks, bonfires and outdoor festival stages",
    wardrobe:
      "denim, flannel, worn leather, boots, hats, simple cotton dresses — lived-in, never styled as fashion editorial",
    lighting:
      "natural sun, golden hour and dusk, moonlight and firelight, practical string lights and stage tungsten; " +
      "soft shadows and real atmospheric haze from dust, not smoke machines",
    banned: [...NO_FUTURE, ...NO_STATIC, "no club choreography", "no rave crowds"],
    grounded: true,
  },
  {
    id: "roots",
    label: "Roots / Acoustic / Folk",
    match:
      /\b(folk|roots|acoustic|singer[- ]?songwriter|appalachian|gospel|blues|delta blues|soul revival|hymn)\b/i,
    environments:
      "intimate rustic venues, wooden church halls, living rooms and porches, forest clearings and riverbanks, " +
      "campfires, old touring vans, back-alley loading docks",
    wardrobe: "plain, weathered everyday clothing; acoustic instruments carried and played on camera",
    lighting: "window daylight, lamplight, candle and campfire glow, golden-hour exteriors; no artificial colour gels",
    banned: [...NO_FUTURE, ...NO_STATIC, "no club choreography"],
    grounded: true,
  },
  {
    id: "southern-gothic",
    label: "Southern Gothic / Outlaw Rock",
    match:
      /\b(southern gothic|outlaw rock|outlaw|swamp rock|desert rock|stoner rock|gothic americana|dark country|murder ballad|preacher|revival tent|debt|sinner|redemption)\b/i,
    environments:
      "weathered wood porches and clapboard houses, roadside bars with amber tungsten glow, cracked asphalt " +
      "highways at dusk, dry fields, rusted trucks, abandoned churches and revival tents, riverbanks and swamps",
    wardrobe:
      "Stetson and worn felt hats, distressed leather jackets, denim, boots, beards, dark sunglasses, rings and " +
      "chains — dusty and lived-in, never fashion-styled",
    lighting:
      "amber and tungsten bar light, hard moody silhouette backlighting, slow-burning smoke and dust in the beam, " +
      "low sun and headlights on asphalt, deep unlit shadow",
    banned: [
      ...NO_FUTURE,
      ...NO_STATIC,
      "no dance troupes or choreography",
      "no cybernetics or implants",
      "no sci-fi cities",
      "no club or festival crowds",
    ],
    grounded: true,
  },
  {

    id: "rock",
    label: "Rock / Nu-Metal",
    match:
      /\b(rock|nu[- ]?metal|punk|grunge|metal|hard rock|southern rock|garage|alt[- ]?rock|guitar solo|amp stack|mosh|headbang)\b/i,
    environments:
      "sweaty club and bar stages, warehouse rehearsal rooms and industrial yards, desert highways, rooftops, " +
      "underpasses, backstage corridors, amp stacks and drum risers, crowd pits",
    wardrobe: "black denim and leather, band tees, boots, chains, sweat and grime; real instruments played hard",
    lighting:
      "harsh tungsten and par-can stage wash, hard backlight through real smoke and dust, blown-out white beams, " +
      "high-contrast night exteriors under sodium streetlight",
    banned: [...NO_FUTURE, ...NO_STATIC, "no EDM festival choreography", "no glossy pop dance routines"],
    grounded: true,
  },
  {
    id: "hiphop",
    label: "Hip-Hop / Rap-Rock",
    match: /\b(hip[- ]?hop|rap|rap[- ]?rock|trap|drill|freestyle|cypher|boom ?bap)\b/i,
    environments:
      "city blocks and stoops, parking garages, basketball courts, corner stores, rooftops, car interiors and " +
      "convoys, block parties, industrial lots",
    wardrobe: "streetwear, jewellery, tracksuits, hoodies, sneakers — authentic and contemporary, not costume",
    lighting:
      "hard daylight, sodium and mercury streetlight, headlights and phone light, practical night realism with deep shadows",
    banned: [...NO_STATIC, "no sci-fi cyber suits", "no holographic tech", "no rave/EDM festival choreography"],
    grounded: false,
  },
  {
    id: "amapiano",
    label: "Amapiano / House",
    match: /\b(amapiano|afro ?house|afrobeat[s]?|house music|deep house|log drum|piano groove|gqom)\b/i,
    environments:
      "rooftop and courtyard parties, township streets, beach and poolside gatherings, open-air day parties, " +
      "dance circles and outdoor sound systems",
    wardrobe: "bright contemporary fashion, sneakers and bucket hats, bold prints, sunglasses",
    lighting:
      "bright sunlight and warm dusk, string lights and simple par cans after dark, saturated natural colour — " +
      "no cold sci-fi grading",
    banned: [...NO_STATIC, "no cyberpunk cityscapes", "no holographic tech", "no sci-fi costumes"],
    grounded: false,
  },
  {
    id: "rnb",
    label: "R&B / Soul",
    match: /\b(r&b|rnb|soul|neo[- ]?soul|slow jam|ballad|quiet storm)\b/i,
    environments:
      "apartments and hotel rooms, night drives, empty bars, rain-slick streets, studio live rooms, intimate interiors",
    wardrobe: "elegant, tactile fabrics, understated modern styling",
    lighting: "soft key light, warm practicals, window light and shallow depth of field, gentle night contrast",
    banned: [...NO_STATIC, "no cyber suits", "no holographic tech", "no rave choreography"],
    grounded: false,
  },
  {
    id: "electronic",
    label: "Electronic / EDM",
    match: /\b(edm|techno|house party|dubstep|synthwave|cyber|rave|electro|dance floor|drum ?and ?bass|trance)\b/i,
    environments: "club floors, warehouse raves, festival main stages, neon-lit streets, laser and LED stage design",
    wardrobe: "club and festival fashion, reflective fabrics",
    lighting: "laser arrays, LED walls, strobes, heavy haze, high-contrast night imagery",
    banned: [...NO_STATIC, "no daytime corporate stock imagery"],
    grounded: false,
  },
];

/** Detects the governing genre law from the script/lyrics (and any explicit hint). */
export function detectGenreLaw(text: string, hint?: string | undefined): GenreLaw | null {
  const haystack = `${hint ?? ""}\n${text}`.slice(0, 8000);
  return GENRE_LAWS.find((law) => law.match.test(haystack)) ?? null;
}

/** Looks a law up by id (used on the render side, where only the id travels). */
export function genreLawById(id: string | undefined | null): GenreLaw | null {
  if (!id) return null;
  return GENRE_LAWS.find((law) => law.id === id) ?? null;
}

/** The planner directive: the genre's visual laws, stated as hard rules. */
export function genreDirective(law: GenreLaw): string {
  return [
    `GENRE VISUAL LAWS — ${law.label}. These are mandatory for every single shot.`,
    `Allowed environments: ${law.environments}.`,
    `Wardrobe: ${law.wardrobe}.`,
    `Lighting physics: ${law.lighting}.`,
    `Banned outright (never depict): ${law.banned.join(", ")}.`,
    "Storyboard the actual narrative of the lyrics — the characters, places and events the song describes — " +
      "and stage that story strictly inside the environments, wardrobe and lighting above. " +
      "Generic pop/club choreography or unrelated stock scenarios are a rule violation.",
  ].join(" ");
}

/** The negative-prompt block appended to every render call for this genre. */
export function genreNegativePrompt(law: GenreLaw): string {
  return `Negative prompt (must not appear): ${law.banned.join(", ")}.`;
}

const FUTURISTIC_TERMS =
  /\b(neon(?:-lit| lights?| signage| glow)?|cyberpunk|cyber ?suits?|holograph(?:ic|s)?|hologram|laser (?:stage|lights?|grid)|LED wall|strobe lights?|nightclub|night ?club|rave|EDM|futuristic|sci-?fi|robotic|android|chrome dystopia)\b/gi;

/**
 * Last-mile safety net: rewrites futuristic wording out of a planned shot when
 * the track is a grounded genre, so a single stray prompt can't neon-ify the film.
 */
export function scrubShotForGenre(shot: string, law: GenreLaw | null): string {
  if (!law?.grounded) return shot;
  const cleaned = shot.replace(FUTURISTIC_TERMS, "warm practical");
  return cleaned === shot
    ? shot
    : `${cleaned} Grounded, real-world ${law.label} setting with natural or practical lighting only.`;
}
