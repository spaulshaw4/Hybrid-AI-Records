/**
 * Local mock mode.
 *
 * When enabled, every AI/cloud generation call in the Visual Engine and the
 * script tooling is bypassed and served from local fixtures instead. No upstream
 * request leaves the box, no V Token wallet check runs, and no provider 402
 * ("out of credits") can ever surface — so raw local builds and the render
 * telemetry / viewport-reconnect-stability harness keep working offline.
 *
 * Flip `LOCAL_MOCK_MODE` to `false` (or set LOCAL_MOCK_MODE=0 /
 * VITE_LOCAL_MOCK_MODE=0) to go back to the live pipeline.
 */

import { PRODUCER_NAME } from "@/lib/producer-identity";

function envFlag(): boolean | null {
  const raw =
    (typeof process !== "undefined" ? process.env?.["LOCAL_MOCK_MODE"] : undefined) ??
    (typeof import.meta !== "undefined"
      ? (import.meta as { env?: Record<string, string | undefined> }).env?.[
          "VITE_LOCAL_MOCK_MODE"
        ]
      : undefined);
  if (raw === undefined || raw === "") return null;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Live-first: mock fixtures are OFF unless explicitly switched on with
 * LOCAL_MOCK_MODE=1 / VITE_LOCAL_MOCK_MODE=1. Station 3 always dispatches the
 * real payload to Replicate using REPLICATE_API_KEY.
 */
export function isLocalMock(): boolean {
  return envFlag() === true;
}

export const LOCAL_MOCK_MODE = isLocalMock();

/** Copy shown in the studio when generation is served from fixtures. */
export const LOCAL_MOCK_NOTICE =
  "Local mock mode: scripts, concepts and renders come from local fixtures. No external API calls and no platform credits are used — add your own engine API keys to run live.";

/** Playable fixture clip used for every mocked render job. */
export const MOCK_VIDEO_URL = "/mock/render-fixture.mp4";

const SHOTS = [
  "Wide establishing shot — dawn over an empty highway, low fog, anamorphic flare, slow dolly forward.",
  "Medium shot — the lead walks through a rain-lit alley, hard key from a single sodium lamp, handheld drift.",
  "Close-up — hands on a battered guitar neck, shallow depth, warm practical light, slow push-in.",
  "Wide shot — silhouette against a stadium wash, smoke, crane rise revealing the crowd.",
  "Insert — vinyl spinning on a charcoal console, crimson LEDs, macro rack focus.",
  "Tracking shot — car interior at night, city lights streak across the windshield, steady lateral move.",
];

function clock(total: number): string {
  const m = Math.floor(total / 60);
  const s = Math.round(total % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Timecoded fixture script covering the requested runtime. */
export function mockScript(durationSeconds = 210, seed = ""): string {
  const beats: string[] = [
    `// LOCAL MOCK SCRIPT — producer ${PRODUCER_NAME}, Hybrid AI Records LLC`,
    seed.trim() ? `// Seed: ${seed.trim().slice(0, 160)}` : "// Seed: none supplied",
  ];
  const step = 7;
  for (let t = 0, i = 0; t < Math.max(step * 3, durationSeconds); t += step, i += 1) {
    const end = Math.min(t + step, Math.max(step * 3, durationSeconds));
    beats.push(`[${clock(t)}-${clock(end)}] SHOT ${i + 1} — ${SHOTS[i % SHOTS.length]}`);
  }
  return beats.join("\n");
}

export const MOCK_STYLE_DIRECTION =
  "Local fixture look: charcoal-and-crimson grade, deep blacks with a single warm key, 35mm anamorphic glass, " +
  "gentle halation on practicals, fine film grain, handheld micro-drift on subject shots and locked wides for " +
  "environments. Avoid neon club palettes, avoid text or watermarks, avoid plastic skin.";

/** Scene blocks matching the live planner's shape. */
export function mockScenes(durationSeconds: number) {
  const count = Math.max(3, Math.min(60, Math.ceil(durationSeconds / 8)));
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    title: `Block ${i + 1}`,
    shot: SHOTS[i % SHOTS.length]!,
    seconds: 8,
    vocalSync: i % 3 === 1,
  }));
}

export function mockPlan(durationSeconds: number) {
  return {
    logline: "A local-fixture cut: one artist, one long road, one last take before dawn.",
    soundtrack: "Uploaded master track, played straight — no generated score in mock mode.",
    scenes: mockScenes(durationSeconds),
    genreId: null as string | null,
    genreLabel: null as string | null,
  };
}

export function mockConceptPreview() {
  return {
    logline: "A local-fixture cut: one artist, one long road, one last take before dawn.",
    narrative:
      "Fixture concept board. The film opens on an empty highway at first light and follows the lead through " +
      "rain-slick side streets into a packed room, cutting between intimate performance inserts and wide, " +
      "unpeopled landscapes. The grade stays charcoal and crimson: deep blacks, one warm key, halation on every " +
      "practical. Lensing is 35mm anamorphic, handheld on the subject and locked for environments, with the cut " +
      "rate climbing into the chorus and dropping away for the final verse.",
    styleTags: [
      "charcoal + crimson grade",
      "35mm anamorphic",
      "single warm key",
      "practical halation",
      "handheld drift",
      "fine film grain",
      "dawn highway",
      "rain-lit alley",
    ],
    frames: [
      { id: "frame-0", kind: "character" as const, title: "Lead — dawn highway", description: SHOTS[0]!, image: null },
      { id: "frame-1", kind: "character" as const, title: "Lead — alley key light", description: SHOTS[1]!, image: null },
      { id: "frame-2", kind: "environment" as const, title: "Console insert", description: SHOTS[4]!, image: null },
      { id: "frame-3", kind: "environment" as const, title: "Stadium wash", description: SHOTS[3]!, image: null },
    ],
  };
}

export function mockCharacterProfile(trackTitle = "") {
  return {
    name: PRODUCER_NAME,
    archetype: trackTitle
      ? `Weathered frontman carrying "${trackTitle.slice(0, 60)}"`
      : "Weathered frontman / road-worn songwriter",
    appearance:
      "Mid-forties, close-cropped greying hair, three-day stubble, weathered face, tired but steady eyes.",
    wardrobe:
      "Dark canvas work jacket over a plain charcoal tee, worn denim, scuffed boots, single silver ring.",
  };
}

let mockJobCounter = 0;

/** Deterministic-ish local job id, accepted by the poll validator. */
export function mockJobId(): string {
  mockJobCounter += 1;
  return `localmock-${Date.now().toString(36)}-${mockJobCounter}`;
}

export function isMockJobId(id: string): boolean {
  return id.startsWith("localmock-");
}

/** Fixture prompt set matching the live generator's shape. */
export function mockPromptSet(count = 12) {
  const sections = ["intro", "verse 1", "pre-chorus", "chorus 1", "verse 2", "chorus 2", "bridge", "outro"];
  return {
    styleLock: "Charcoal Americana / Road Noir (local fixture)",
    styleTags: [
      "charcoal + crimson grade",
      "35mm anamorphic",
      "single warm key",
      "practical halation",
      "fine film grain",
      "handheld drift",
    ],
    negativePrompt:
      "no text, no watermark, no captions, no neon club palette, no plastic skin, no extra limbs, no logos",
    prompts: Array.from({ length: count }, (_, i) => ({
      index: i + 1,
      section: sections[i % sections.length]!,
      startSeconds: i * 8,
      seconds: 8,
      camera: ["slow dolly in", "handheld drift", "locked wide", "crane rise", "macro rack focus"][i % 5]!,
      prompt: `${SHOTS[i % SHOTS.length]} Charcoal and crimson grade, 35mm anamorphic, fine film grain.`,
      negative: "no text, no watermark, no neon club palette",
      vocalSync: i % 3 === 1,
    })),
  };
}
