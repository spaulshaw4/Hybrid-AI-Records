/**
 * Catalog of primary visual styles, cinematic genres, colour-grading palettes
 * and mood-board references used by the Visual Engine. Everything here is
 * client-safe: the studio renders the pickers from it and the render pipeline
 * turns the same ids into prompt direction, so the UI and the engine can never
 * drift apart.
 */

export type VisualStyle = {
  id: string;
  label: string;
  /** Prompt direction injected into the shot planner. */
  direction: string;
};

export type StyleGroup = {
  id: string;
  label: string;
  styles: VisualStyle[];
};

export const STYLE_GROUPS: StyleGroup[] = [
  {
    id: "live-action",
    label: "Live action & photographic",
    styles: [
      {
        id: "photorealistic",
        label: "Photorealistic (cinematic 1080p → 4K)",
        direction:
          "photorealistic cinematic footage, anamorphic lensing, filmic grain, dramatic contrast",
      },
      {
        id: "documentary",
        label: "Documentary vérité",
        direction:
          "handheld documentary vérité, available light, natural skin tones, observational framing",
      },
      {
        id: "35mm-film",
        label: "35mm film stock",
        direction:
          "35mm celluloid capture, halation on highlights, organic grain, soft filmic roll-off",
      },
      {
        id: "16mm-grain",
        label: "16mm grainy nostalgia",
        direction:
          "16mm reversal stock, heavy grain, gate weave, slightly faded nostalgic colour",
      },
      {
        id: "imax-epic",
        label: "IMAX large-format epic",
        direction:
          "IMAX large-format clarity, vast negative space, deep focus, monumental scale",
      },
      {
        id: "black-white",
        label: "High-contrast black & white",
        direction:
          "monochrome cinematography, deep blacks, silver highlights, sculpted contrast",
      },
      {
        id: "vhs-lofi",
        label: "VHS / lo-fi analogue",
        direction:
          "VHS tape artefacts, chroma bleed, scanlines, degraded lo-fi analogue texture",
      },
      {
        id: "super8",
        label: "Super 8 memory reel",
        direction:
          "Super 8 home-movie texture, light leaks, warm faded palette, hand-cranked motion",
      },
    ],
  },
  {
    id: "genre",
    label: "Cinematic genres",
    styles: [
      {
        id: "noir",
        label: "Film noir",
        direction:
          "film noir chiaroscuro, venetian-blind shadows, rain-slick streets, smoke-lit interiors",
      },
      {
        id: "neo-noir",
        label: "Neo-noir neon",
        direction:
          "neo-noir neon nightscape, wet reflective asphalt, magenta and cyan practicals, moody haze",
      },
      {
        id: "cyberpunk",
        label: "Cyberpunk",
        direction:
          "cyberpunk megacity, holographic signage, volumetric neon fog, chrome and rain",
      },
      {
        id: "sci-fi",
        label: "Hard sci-fi",
        direction:
          "hard sci-fi realism, clinical practical lighting, tactile hardware, cold blue interiors",
      },
      {
        id: "horror",
        label: "Horror / dread",
        direction:
          "horror cinematography, suffocating darkness, single motivated source, unsettling negative space",
      },
      {
        id: "thriller",
        label: "Psychological thriller",
        direction:
          "psychological thriller framing, tight lenses, claustrophobic blocking, desaturated tension",
      },
      {
        id: "western",
        label: "Spaghetti western",
        direction:
          "spaghetti western vistas, dust-baked sun, extreme wides cut to extreme close-ups, ochre palette",
      },
      {
        id: "war-epic",
        label: "War epic",
        direction:
          "war epic realism, shutter-stuttered action, ash and cordite haze, muted battlefield palette",
      },
      {
        id: "fantasy",
        label: "High fantasy",
        direction:
          "high fantasy grandeur, painterly god-rays, sweeping crane moves, rich jewel-toned palette",
      },
      {
        id: "post-apoc",
        label: "Post-apocalyptic",
        direction:
          "post-apocalyptic wasteland, sun-bleached decay, dust particulates, scorched palette",
      },
      {
        id: "heist",
        label: "Slick heist",
        direction:
          "slick heist cinematography, kinetic whip-pans, glossy blacks, precision symmetry",
      },
      {
        id: "romance",
        label: "Romantic drama",
        direction:
          "romantic drama warmth, golden-hour softness, shallow depth of field, tender close coverage",
      },
    ],
  },
  {
    id: "music-video",
    label: "Music video looks",
    styles: [
      {
        id: "performance",
        label: "Stage performance",
        direction:
          "live stage performance coverage, moving spotlights, haze beams, crowd silhouettes",
      },
      {
        id: "hiphop-lux",
        label: "Hip-hop luxury",
        direction:
          "hip-hop luxury visual, hard flash aesthetic, gold and chrome specular highlights, wide-angle swagger",
      },
      {
        id: "dreampop",
        label: "Dream-pop haze",
        direction:
          "dream-pop haze, diffusion filters, pastel bloom, slow floating camera",
      },
      {
        id: "y2k",
        label: "Y2K glossy",
        direction:
          "Y2K glossy pop aesthetic, chrome type energy, hard key light, saturated candy palette",
      },
      {
        id: "afrobeats",
        label: "Afrobeats vibrance",
        direction:
          "Afrobeats vibrance, sunlit colour saturation, textile pattern richness, rhythmic camera energy",
      },
      {
        id: "grunge",
        label: "Grunge / underground",
        direction:
          "grunge underground look, blown highlights, dirty practicals, raw handheld energy",
      },
    ],
  },
  {
    id: "animation",
    label: "Animation & illustration",
    styles: [
      {
        id: "cartoon",
        label: "Cartoon & anime",
        direction: "stylised 2D animation, bold linework, saturated cinematic colour",
      },
      {
        id: "anime-cel",
        label: "Classic cel anime",
        direction:
          "classic cel anime, hand-painted backgrounds, limited animation timing, warm film bloom",
      },
      {
        id: "claymation",
        label: "Claymation & 3D render",
        direction:
          "handcrafted stop-motion claymation, tactile textures, practical lighting",
      },
      {
        id: "pixar-3d",
        label: "Stylised 3D feature",
        direction:
          "stylised 3D feature animation, soft global illumination, appealing character shapes",
      },
      {
        id: "comic-ink",
        label: "Comic ink & halftone",
        direction:
          "comic-book ink rendering, halftone shading, hard black linework, graphic panels",
      },
      {
        id: "watercolor",
        label: "Watercolour illustration",
        direction:
          "watercolour illustration, bleeding pigment edges, paper texture, gentle motion",
      },
      {
        id: "pixel-art",
        label: "Pixel art",
        direction: "pixel art rendering, limited palette, crisp dithering, retro game framing",
      },
      {
        id: "vector-flat",
        label: "Flat vector motion",
        direction:
          "flat vector motion design, geometric shapes, bold colour blocking, snappy transitions",
      },
    ],
  },
  {
    id: "experimental",
    label: "Experimental & abstract",
    styles: [
      {
        id: "surreal",
        label: "Surreal dreamscape",
        direction:
          "surreal dreamscape, impossible architecture, drifting scale shifts, uncanny calm",
      },
      {
        id: "glitch",
        label: "Glitch / datamosh",
        direction:
          "glitch datamosh aesthetic, pixel smearing, RGB split, corrupted frame artefacts",
      },
      {
        id: "liquid-light",
        label: "Liquid light show",
        direction:
          "liquid light show, oil-and-water projections, organic colour blooms, analogue psychedelia",
      },
      {
        id: "infrared",
        label: "Infrared / thermal",
        direction:
          "infrared thermal imaging, false-colour heat mapping, ghostly luminance",
      },
      {
        id: "macro-abstract",
        label: "Macro abstraction",
        direction:
          "extreme macro abstraction, texture as subject, razor-thin focus planes",
      },
      {
        id: "vaporwave",
        label: "Vaporwave",
        direction:
          "vaporwave aesthetic, gridded horizons, pastel neon gradients, statue-and-chrome motifs",
      },
    ],
  },
  {
    id: "professional",
    label: "Professional camera & format looks",
    styles: [
      {
        id: "arri-alexa",
        label: "Large-sensor digital (ARRI-style)",
        direction:
          "large-sensor digital cinema capture, creamy highlight roll-off, true skin tones, shallow depth of field",
      },
      {
        id: "anamorphic-scope",
        label: "2.39:1 anamorphic scope",
        direction:
          "2.39:1 anamorphic scope framing, oval bokeh, horizontal flares, wide compositional negative space",
      },
      {
        id: "spherical-prime",
        label: "Spherical prime naturalism",
        direction:
          "spherical prime lenses, natural perspective, minimal distortion, restrained depth of field",
      },
      {
        id: "long-lens-compression",
        label: "Long-lens compression",
        direction:
          "200mm long-lens compression, stacked planes, isolated subject against soft background",
      },
      {
        id: "wide-angle-immersive",
        label: "Wide-angle immersion",
        direction:
          "14–24mm wide-angle immersion, deep space, exaggerated foreground, subject close to lens",
      },
      {
        id: "probe-lens",
        label: "Probe-lens macro motion",
        direction:
          "probe-lens macro motion, impossible traversals through tight spaces, deep focus throughout",
      },
      {
        id: "hdr-dolby",
        label: "HDR high-dynamic-range master",
        direction:
          "HDR mastering, specular highlight detail, deep retained shadow information, wide colour volume",
      },
      {
        id: "studio-cyclorama",
        label: "Studio cyclorama / seamless",
        direction:
          "studio cyclorama seamless backdrop, controlled soft key, clean commercial separation",
      },
      {
        id: "led-volume",
        label: "LED volume virtual production",
        direction:
          "LED volume virtual production, in-camera environment lighting, wrapped interactive light on subject",
      },
      {
        id: "one-light-portrait",
        label: "Single-source portrait",
        direction:
          "single hard source portraiture, sculpted falloff, deep negative fill, editorial contrast",
      },
      {
        id: "natural-window",
        label: "Natural window light",
        direction:
          "soft natural window light, gentle directional falloff, honest colour, no artificial fill",
      },
      {
        id: "high-speed",
        label: "High-speed phantom capture",
        direction:
          "high-speed 1000fps capture, hyper-detailed slow motion, crisp motion-free frames, powerful strobe-free lighting",
      },
    ],
  },
];


export const DEFAULT_STYLE = "photorealistic";

const STYLE_INDEX = new Map<string, VisualStyle>(
  STYLE_GROUPS.flatMap((g) => g.styles).map((s) => [s.id, s]),
);

export function findVisualStyle(id: string): VisualStyle | undefined {
  return STYLE_INDEX.get(id);
}

export function styleDirectionFor(id: string): string {
  return (STYLE_INDEX.get(id) ?? STYLE_INDEX.get(DEFAULT_STYLE)!).direction;
}

export function styleLabelFor(id: string): string {
  return (STYLE_INDEX.get(id) ?? STYLE_INDEX.get(DEFAULT_STYLE)!).label;
}

/* ------------------------------------------------------------------ */
/* Mood board                                                          */
/* ------------------------------------------------------------------ */

export type ColorGrade = {
  id: string;
  label: string;
  /** Swatches shown in the mood board UI. */
  swatches: string[];
  direction: string;
};

export const COLOR_GRADES: ColorGrade[] = [
  {
    id: "teal-orange",
    label: "Teal & orange blockbuster",
    swatches: ["#0b2b33", "#126b74", "#e0794a", "#f6c99f"],
    direction: "teal-and-orange blockbuster grade, cool shadows against warm skin tones",
  },
  {
    id: "crimson-noir",
    label: "Crimson noir",
    swatches: ["#08080a", "#1c1013", "#8f1120", "#d94055"],
    direction: "crimson noir grade, near-black shadows pierced by deep red practicals",
  },
  {
    id: "gold-dusk",
    label: "Gold dusk",
    swatches: ["#20160b", "#6b4713", "#c99334", "#f4dda2"],
    direction: "golden-hour dusk grade, amber highlights, warm dense shadows",
  },
  {
    id: "cyan-neon",
    label: "Cyan neon night",
    swatches: ["#04121c", "#0a3a52", "#19c6d6", "#a8f4ff"],
    direction: "cyan neon night grade, electric highlights, ink-blue shadow field",
  },
  {
    id: "bleach-bypass",
    label: "Bleach bypass",
    swatches: ["#151515", "#4c4f4c", "#9aa09a", "#e8ece7"],
    direction: "bleach-bypass grade, crushed saturation, silvery contrast, hard highlights",
  },
  {
    id: "pastel-bloom",
    label: "Pastel bloom",
    swatches: ["#2b2333", "#7d6a9c", "#e3a5c7", "#fbe6f0"],
    direction: "pastel bloom grade, lifted blacks, soft rose and lilac diffusion",
  },
  {
    id: "desert-sepia",
    label: "Desert sepia",
    swatches: ["#241a12", "#6d4c30", "#b98b56", "#e8cfa5"],
    direction: "desert sepia grade, dust-warmed midtones, sun-bleached highlights",
  },
  {
    id: "monochrome",
    label: "Silver monochrome",
    swatches: ["#000000", "#3a3a3a", "#8d8d8d", "#f2f2f2"],
    direction: "silver monochrome grade, sculpted greyscale tonality, no colour cast",
  },
  {
    id: "toxic-green",
    label: "Toxic green",
    swatches: ["#0b1409", "#2c4a1d", "#77b043", "#d7f59a"],
    direction: "toxic green grade, sickly institutional cast, cold green midtones",
  },
  {
    id: "arctic-blue",
    label: "Arctic blue",
    swatches: ["#0a1420", "#1f3d5c", "#5f9fd1", "#dcefff"],
    direction: "arctic blue grade, frigid highlights, minimal warmth, glacial clarity",
  },
];

const GRADE_INDEX = new Map(COLOR_GRADES.map((g) => [g.id, g]));

export function colorGradeFor(id: string): ColorGrade | undefined {
  return GRADE_INDEX.get(id);
}

/** Curated visual-inspiration references a producer can toggle on. */
export const MOOD_REFERENCES: { id: string; label: string; direction: string }[] = [
  { id: "anamorphic-flare", label: "Anamorphic flares", direction: "horizontal anamorphic lens flares" },
  { id: "volumetric-haze", label: "Volumetric haze", direction: "thick volumetric atmosphere and light shafts" },
  { id: "rain-reflection", label: "Rain reflections", direction: "rain-soaked reflective surfaces" },
  { id: "practical-neon", label: "Practical neon", direction: "in-frame neon practicals as key light" },
  { id: "silhouette", label: "Silhouette blocking", direction: "strong backlit silhouette blocking" },
  { id: "handheld", label: "Handheld energy", direction: "restless handheld camera energy" },
  { id: "slow-dolly", label: "Slow dolly", direction: "slow deliberate dolly and crane moves" },
  { id: "symmetry", label: "Centred symmetry", direction: "centred symmetrical compositions" },
  { id: "dutch-angle", label: "Dutch angles", direction: "off-axis dutch-angle framing" },
  { id: "macro-detail", label: "Macro detail cuts", direction: "macro insert cuts on textures and details" },
  { id: "smoke", label: "Smoke & embers", direction: "drifting smoke and floating embers" },
  { id: "golden-hour", label: "Golden hour", direction: "low golden-hour sun angle" },
  { id: "hard-flash", label: "Hard flash", direction: "hard direct on-camera flash look" },
  { id: "slow-motion", label: "Slow motion", direction: "high-frame-rate slow-motion beats" },
  { id: "aerial", label: "Aerial scale", direction: "aerial establishing scale shots" },
  { id: "long-take", label: "Long takes", direction: "extended unbroken long takes" },
  { id: "shallow-focus", label: "Shallow focus", direction: "razor-shallow focus with soft falloff backgrounds" },
  { id: "deep-focus", label: "Deep focus", direction: "deep focus with every plane sharp" },
  { id: "backlit-haze", label: "Backlit haze", direction: "heavy backlight raking through atmospheric haze" },
  { id: "mirror-glass", label: "Mirrors & glass", direction: "reflections shot through mirrors, glass and water" },
  { id: "crowd-energy", label: "Crowd energy", direction: "dense crowd energy surrounding the subject" },
  { id: "negative-space", label: "Negative space", direction: "vast negative space isolating the subject" },
  { id: "top-down", label: "Top-down overheads", direction: "top-down overhead compositions" },
  { id: "whip-pan", label: "Whip-pan transitions", direction: "whip-pan and swish transitions between beats" },
  { id: "candle-fire", label: "Firelight", direction: "flickering firelight and candle practicals as key" },
  { id: "colour-blocking", label: "Colour blocking", direction: "bold single-colour blocking per location" },

];

const REFERENCE_INDEX = new Map(MOOD_REFERENCES.map((r) => [r.id, r]));

export type MoodBoard = {
  /** Colour grade id from COLOR_GRADES. */
  grade?: string | undefined;
  /** Reference ids from MOOD_REFERENCES. */
  references?: string[] | undefined;
  /** Free-form producer notes. */
  notes?: string | undefined;
};

export const MOOD_NOTES_MAX = 600;

/** Turns a mood board into one prompt sentence, or "" when nothing is set. */
export function moodBoardDirection(mood: MoodBoard | undefined | null): string {
  if (!mood) return "";
  const parts: string[] = [];
  const grade = mood.grade ? GRADE_INDEX.get(mood.grade) : undefined;
  if (grade) parts.push(grade.direction);
  const refs = (mood.references ?? [])
    .map((id) => REFERENCE_INDEX.get(id)?.direction)
    .filter((d): d is string => Boolean(d));
  if (refs.length) parts.push(refs.join(", "));
  const notes = (mood.notes ?? "").trim();
  if (notes) parts.push(notes.slice(0, MOOD_NOTES_MAX));
  return parts.join(". ");
}

export const MOOD_BOARD_KEY = "hybrid.studio.moodBoard";

export function readMoodBoard(): MoodBoard {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(MOOD_BOARD_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const m = parsed as MoodBoard;
    return {
      grade: typeof m.grade === "string" ? m.grade : undefined,
      references: Array.isArray(m.references)
        ? m.references.filter((r): r is string => typeof r === "string")
        : [],
      notes: typeof m.notes === "string" ? m.notes : "",
    };
  } catch {
    return {};
  }
}

export function writeMoodBoard(mood: MoodBoard): void {
  try {
    window.localStorage.setItem(MOOD_BOARD_KEY, JSON.stringify(mood));
  } catch {
    /* storage unavailable — mood board stays in memory for this session */
  }
}
