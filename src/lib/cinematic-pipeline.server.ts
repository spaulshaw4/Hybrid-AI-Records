/**
 * V Engine cinematic pipeline (server only).
 *
 * Orchestration mirrors the three-stage brief:
 *   1. Script parsing — the script is structured into sequential scene blocks.
 *   2. Audio direction — a soundtrack brief is derived for the Hybrid audio engine.
 *   3. Visual render — a render job is created on the primary visual engine,
 *      with automatic failover to the backup engine when the primary spikes.
 *
 * Vendor names never leave this module: the client only ever sees the
 * white-labelled engine labels from `V_ENGINES`.
 */

import { moodBoardDirection, styleDirectionFor, type MoodBoard } from "@/lib/visual-styles";
import { aiChatFetch } from "@/lib/ai-chat.server";
import { aiChatUrl, aiHeaders, aiTextModel } from "@/lib/ai-provider.server";
import {
  detectGenreLaw,
  genreDirective,
  genreLawById,
  genreNegativePrompt,
  scrubShotForGenre,
  type GenreLaw,
} from "@/lib/cinematic-genre";
import {
  characterDirective,
  characterDisplayName,
  hasCharacterProfile,
  type CharacterProfile,
} from "@/lib/character-profile";
import { producerIdentityDirective } from "@/lib/producer-identity";
import { throwGatewayError } from "./ai-error.server";
import {
  createFoundationFrame,
  createMotionBlock,
  firstOutputUrl,
  predictionProgress,
  readPrediction,
} from "@/lib/visual-engines.server";

import { clampResolutionLanguage } from "@/lib/render-resolution";
import {
  barSeconds,
  clampTimeline,
  nearestBeatSeconds,
  renderableBlock,
} from "@/lib/beat-grid";
import {
  buildEditTimeline,
  heroCameraMove,
  planHeroBlocks,
  type EditCut,
} from "@/lib/hero-shots";


import { assertRenderable } from "@/lib/pipeline-guard.server";




/**
 * White-labelled motion engines, in failover order. The actual vendor routing
 * (motion engine + silent fail-safe) lives in `visual-engines.server`.
 */
export const V_ENGINES = [
  { id: "primary", label: "V Engine Prime" },
  { id: "backup", label: "V Engine Backup" },
  { id: "reserve", label: "V Engine Reserve" },
] as const;

export type VEngineId = (typeof V_ENGINES)[number]["id"];

export type ScenePlan = {
  index: number;
  title: string;
  shot: string;
  seconds: number;
  /** True when a performer visibly sings the lead vocal — triggers lip-sync. */
  vocalSync?: boolean;
};

export type RenderPlan = {
  logline: string;
  soundtrack: string;
  scenes: ScenePlan[];
  /** Governing genre law id, so every later shot render inherits the same rules. */
  genreId: string | null;
  /** Human label of the governing genre law, for the operator UI. */
  genreLabel: string | null;
  /** Bar-synced pacing cuts the editor makes across the rendered hero angles. */
  editTimeline?: EditCut[];
  /** Exact master runtime (audio duration) the export is clamped to. */
  masterSeconds?: number;

};

export type StyleMode = "photorealistic" | "cartoon" | "claymation";


function styleDirection(styleMode: string): string {
  return styleDirectionFor(styleMode);
}


function subjectDirection(subjectMode: string): string {
  if (subjectMode === "places") return "location-led storytelling, environments as the lead subject";
  if (subjectMode === "objects") return "macro product-grade object storytelling";
  if (subjectMode === "scenery") return "pure cinematic scenery, no people on screen";
  if (subjectMode === "story")
    return "song-driven story mode: a continuous music-video narrative cut to the track, performers and imagery synchronised to the music";
  return "human performers as the lead subject, consistent faces and wardrobe across shots";
}

/** Musical timing map derived in the browser from the uploaded song. */
export type AudioTiming = {
  durationSeconds: number;
  bpm: number | null;
  cuts: number[];
  energy: number[];
  /** Inferred song structure (intro / verse / chorus / drop …). */
  sections?: { start: number; end: number; label: string; energy: number }[];
  /** Stem separation + transient profile from the audio ingestion node. */
  stems?: {
    low: number;
    mid: number;
    high: number;
    transientDensity: number;
    vocalWindows: { start: number; end: number }[];
  };
};

/** True when a lead vocal is present at this point in the track. */
function vocalAt(timing: AudioTiming, seconds: number): boolean {
  return (timing.stems?.vocalWindows ?? []).some((w) => seconds >= w.start && seconds < w.end);
}


/** Names the song section a scene block starts inside. */
function sectionAt(timing: AudioTiming, seconds: number): string | undefined {
  return timing.sections?.find((s) => seconds >= s.start && seconds < s.end)?.label;
}


/** Snaps a musical segment length onto a renderable block length. */
function blockSeconds(seconds: number): 4 | 6 | 8 {
  return renderableBlock(seconds);
}

/**
 * Turns cut points into per-scene block lengths, snapped to the song's bar
 * grid (1–3 bars) and hard-clamped to the track duration so the timeline never
 * runs past the audio (surplus shots dropped, final shot trimmed).
 */
function musicalSegments(timing: AudioTiming, target: number): number[] {
  const bpm = timing.bpm;
  const bar = barSeconds(bpm);
  const segments: number[] = [];
  let previous = 0;
  for (const cut of timing.cuts) {
    const length = cut - previous;
    previous = cut;
    if (length <= 0) continue;
    segments.push(nearestBeatSeconds(length, bpm, { minBars: 1, maxBars: 3 }));
  }

  // Never plan past the paid runtime or the master track, whichever is shorter.
  const ceiling = Math.min(target, timing.durationSeconds || target);
  const trimmed: number[] = [];
  let total = 0;
  for (const segment of segments) {
    if (total >= ceiling || trimmed.length >= 60) break;
    trimmed.push(segment);
    total += segment;
  }
  while (total < ceiling - 0.25 && trimmed.length < 60) {
    const remaining = ceiling - total;
    const next = nearestBeatSeconds(Math.min(bar * 3, remaining), bpm, { minBars: 1, maxBars: 3 });
    trimmed.push(next);
    total += next;
  }
  return clampTimeline(trimmed, ceiling, bpm);
}


/**
 * Robust JSON extraction: strips markdown fences and any conversational
 * wrapper before parsing. Returns null when nothing parses.
 */
function extractScriptPlanJson(rawResponse: string): {
  logline?: unknown;
  soundtrack?: unknown;
  scenes?: Array<Record<string, unknown>>;
} | null {
  let text = (rawResponse ?? "").trim();
  if (!text) return null;

  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) text = jsonMatch[0];

  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as {
          logline?: unknown;
          soundtrack?: unknown;
          scenes?: Array<Record<string, unknown>>;
        })
      : null;
  } catch {
    return null;
  }
}

/** Deterministic fallback plan so the workflow never hard-fails on malformed model output. */
function fallbackPlan(input: {
  script: string;
  styleMode: string;
  subjectMode: string;
  durationSeconds: number;
  audioTiming?: AudioTiming | undefined;
  character?: CharacterProfile | null | undefined;
}, genre: GenreLaw | null): { logline: string; soundtrack: string; scenes: ScenePlan[] } {
  const target = Math.max(8, Math.round(input.durationSeconds));
  const segments =
    input.audioTiming && input.audioTiming.cuts.length > 1
      ? musicalSegments(input.audioTiming, target)
      : Array.from({ length: Math.max(3, Math.min(60, Math.ceil(target / 8))) }, () => 8);

  const blocks: number[] = [];
  let total = 0;
  for (const s of segments) {
    if (total >= target || blocks.length >= 60) break;
    const remaining = target - total;
    if (remaining <= 0) break;
    const sec = Math.min(s, Math.max(4, remaining));
    blocks.push(sec >= 8 ? 8 : sec >= 6 ? 6 : 4);
    total += sec;
  }

  const characterLine = hasCharacterProfile(input.character)
    ? `Featuring ${characterDisplayName(input.character!)}${
        input.character?.appearance ? ` — ${input.character.appearance}` : ""
      }.`
    : "";
  const style = styleDirectionFor(input.styleMode);
  const negative = genre ? ` ${genreNegativePrompt(genre)}` : "";

  const scenes = blocks.map((seconds, i) => ({
    index: i,
    title: `Fallback Scene ${i + 1}`,
    shot: scrubShotForGenre(
      `Cinematic ${style} music-video shot, continuous moving camera and subject motion. ${characterLine} ` +
        `Atmospheric lighting, strong depth, professional framing. Maintain visual continuity from the previous block.${negative}`,
      genre,
    ),
    seconds: seconds as 4 | 6 | 8,
    vocalSync: false,
  }));

  return {
    logline: `Fallback plan: ${style} music video treatment. Re-run the planner for a richer script breakdown.`,
    soundtrack: "Cinematic score matching the original track's mood and pacing.",
    scenes,
  };
}

/** Stage 1 + 2: turn a raw script into sequential scene blocks and an audio brief. */
export async function planCinematicScript(input: {
  script: string;
  subjectMode: string;
  styleMode: string;
  durationSeconds: number;
  audioTiming?: AudioTiming | undefined;
  moodBoard?: MoodBoard | undefined;
  /** Manual genre law id chosen in the studio; overrides auto-detection. */
  genreOverride?: string | null | undefined;
  /** Manual mood/tone words chosen in the studio; overrides the detected mood. */
  moodOverride?: string | null | undefined;
  /** Character Builder profile injected into every subject shot. */
  character?: CharacterProfile | null | undefined;
}): Promise<RenderPlan> {
  const sceneCount = Math.max(3, Math.min(60, Math.ceil(input.durationSeconds / 8)));
  const moodOverride = (input.moodOverride ?? "").trim();
  const detectedMood = moodBoardDirection(input.moodBoard);
  const mood = moodOverride
    ? `${moodOverride}${detectedMood ? ` — ${detectedMood}` : ""}`
    : detectedMood;
  // The uploaded song's own genre decides the visual world — a country or roots
  // track must never be planned as a neon club video.
  const genre =
    genreLawById(input.genreOverride) ?? detectGenreLaw(input.script, input.styleMode);





  const response = await aiChatFetch({
    body: JSON.stringify({
      model: aiTextModel(),
      messages: [
        {
          role: "system",
          content:
            "You are the shot-planning director for an automated cinematic pipeline. " +
            "Break the script into sequential scene blocks that render as continuous coverage with zero manual editing. " +
            "When a song is supplied, every scene must come out of THAT track: its genre, tempo, mood and lyrical themes. " +
            "Never fall back on generic dance-floor, club, neon-nightclub or EDM presets unless the song itself is that genre. " +
            "For country, roots, acoustic or rock tracks, futuristic and cyberpunk imagery (neon cityscapes, holographic " +
            "overlays, cyber suits, laser dance stages) is forbidden — use authentic real-world locations and natural or " +
            "practical light instead. Storyboard the events, characters and places described in the lyrics. " +

            "Never plan title cards, credits, logo stings, split-screen panels, character sheets, photo montages or any " +
            "static frame — every block is live-action motion with a moving camera and moving subjects. " +
            "Respond with strict, valid JSON only. Do NOT include markdown code blocks, backticks, or any conversational preamble/postscript. Start your response immediately with { or [. " +
            "Reply in this shape: {\"logline\":string,\"soundtrack\":string,\"scenes\":[{\"title\":string,\"shot\":string,\"seconds\":number,\"vocal_sync\":boolean}]}. " +
            "Set `vocal_sync` true ONLY for tight close-up or medium hero performance shots where the character sings " +
            "directly to camera with the mouth clearly visible in frame. " +
            "Set `vocal_sync` false for every wide shot, dance routine, atmospheric cutaway, action scene, b-roll, " +
            "scenery, object, crowd, hands, back-of-head or any shot with no visible singing mouth. " +
            "Each `shot` is a single self-contained English video prompt including camera move, lighting and subject continuity. " +
            "`soundtrack` is a one-sentence brief for the score.",
        },
        {
          role: "user",
          content: [
            producerIdentityDirective(),
            `Target runtime: ${input.durationSeconds} seconds across about ${sceneCount} scenes.`,
            `Visual style: ${styleDirection(input.styleMode)}.`,
            ...(genre ? [genreDirective(genre)] : []),

            ...(mood
              ? [
                  `Mood board (apply to every scene): ${mood}. ` +
                    "Bake this colour grade and these visual references into each `shot` prompt.",
                ]
              : []),
            `Subject mode: ${subjectDirection(input.subjectMode)}.`,
            ...(hasCharacterProfile(input.character)
              ? [
                  characterDirective(input.character),
                  `Every scene featuring the subject must open with "Featuring ${characterDisplayName(
                    input.character!,
                  )}, …" and restate their wardrobe and physical details inside the \`shot\` prompt.`,
                ]
              : []),
            "Every `shot` must describe continuous on-screen movement (subject action plus a camera move). " +
              "Do not describe still photographs, portraits held on screen, panels or slideshows.",
            ...(input.audioTiming
              ? [
                  `The film is cut to an uploaded song: ${Math.round(input.audioTiming.durationSeconds)}s long${
                    input.audioTiming.bpm ? `, ${input.audioTiming.bpm} BPM` : ""
                  }, with ${input.audioTiming.cuts.length} musical cut points. ` +
                    "Every scene block must land on one of those cuts, so pace the shot language to the music: " +
                    "quiet passages get slower, longer camera moves and high-energy passages get punchier, kinetic coverage. " +
                    "`soundtrack` must describe the uploaded track, not a new score. " +
                    "Read the genre, tempo, mood and lyrical themes of the script/lyrics above and build the imagery from them — " +
                    "no default club or dance-video imagery.",
                  ...(input.audioTiming.stems
                    ? [
                        `Stem profile from the ingestion node — low ${input.audioTiming.stems.low}, mid ${input.audioTiming.stems.mid}, high ${input.audioTiming.stems.high}, ` +
                          `${input.audioTiming.stems.transientDensity} transients/sec. ` +
                          (input.audioTiming.stems.vocalWindows.length
                            ? `Lead vocal is present at: ${input.audioTiming.stems.vocalWindows
                                .slice(0, 12)
                                .map((w) => `${Math.round(w.start)}–${Math.round(w.end)}s`)
                                .join(", ")}. Set \`vocal_sync\` true for blocks inside those windows and keep instrumental windows on performance-free coverage.`
                            : ""),
                      ]
                    : []),

                  ...((input.audioTiming.sections ?? []).length
                    ? [
                        `Song structure (start → end seconds): ${(input.audioTiming.sections ?? [])
                          .map(
                            (s) =>
                              `${s.label} ${Math.round(s.start)}-${Math.round(s.end)}s`,
                          )
                          .join(", ")}. ` +
                          "Build the story arc onto that structure: intros establish the world, verses carry the narrative, " +
                          "choruses and drops deliver the hero imagery and widest coverage, breakdowns go intimate, outros resolve.",
                      ]
                    : []),
                ]
              : []),

            "Script:",
            input.script.slice(0, 15000),
          ].join("\n"),
        },

      ],
    }),
  });

  if (!response.ok) await throwGatewayError(response, "Script orchestration");

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = payload.choices?.[0]?.message?.content?.trim() ?? "";

  const parsed = extractScriptPlanJson(raw);
  const fallback = fallbackPlan(input, genre);

  const scenes: ScenePlan[] = (parsed?.scenes ?? [])
    .map((scene, index) => ({
      index,
      title: String(scene["title"] ?? `Scene ${index + 1}`).slice(0, 120),
      shot: scrubShotForGenre(String(scene["shot"] ?? "").slice(0, 1500), genre),
      seconds: Math.max(4, Math.min(8, Number(scene["seconds"]) || 8)),
      vocalSync: scene["vocal_sync"] === true,
    }))
    .filter((scene) => scene.shot.length > 0);

  if (!scenes.length) {
    console.error("[Script Planner Parser Error]", raw);
  }

  const resolvedPlan = scenes.length > 0 ? parsed : null;
  const logline =
    typeof resolvedPlan?.logline === "string" && resolvedPlan.logline.trim()
      ? resolvedPlan.logline.trim().slice(0, 400)
      : fallback.logline;
  const soundtrack =
    typeof resolvedPlan?.soundtrack === "string" && resolvedPlan.soundtrack.trim()
      ? resolvedPlan.soundtrack.trim().slice(0, 400)
      : fallback.soundtrack;
  const resolvedScenes = scenes.length > 0 ? scenes : fallback.scenes;

  // Cost control: the master is built from 6–8 extended HERO angles of 8–10s,
  // never from dozens of micro-clips. The editor then makes bar-synced pacing
  // cuts across those angles to cover the whole track.
  const target = Math.max(8, Math.round(input.durationSeconds));

  if (input.audioTiming && input.audioTiming.durationSeconds > 0) {
    const timing = input.audioTiming;
    const trackSeconds = Number(timing.durationSeconds.toFixed(3));
    const blocks = planHeroBlocks(trackSeconds);
    const cuts = buildEditTimeline(blocks.length, trackSeconds, timing.bpm);

    const heroes: ScenePlan[] = blocks.map((seconds, i) => {
      const own = cuts.filter((c) => c.heroIndex === i);
      const at = own[0]?.start ?? 0;
      const energy = timing.energy[i] ?? 0.5;
      const section = sectionAt(timing, at);
      const source = resolvedScenes[i % resolvedScenes.length]!;
      const singing =
        source.vocalSync === true || own.some((c) => vocalAt(timing, c.start));
      const pacing =
        energy > 0.66
          ? "High-energy passage: fast, kinetic camera travel that never stops moving."
          : energy > 0.33
            ? "Mid-energy passage: steady, flowing camera travel with continuous subject motion."
            : "Quiet passage: slow, patient camera travel — still gliding, never frozen.";
      const structure = section ? ` This master angle covers the ${section} of the song.` : "";
      return {
        index: i,
        vocalSync: singing,
        title: `Hero angle ${i + 1} — ${source.title}`,
        shot:
          `${source.shot} Camera: ${heroCameraMove(i)}. ${pacing}${structure} ` +
          `One continuous ${seconds}s take with unbroken motion from the first to the last frame — ` +
          "no static poses, no held portraits, no slideshow frames. Match lighting and wardrobe with the other angles.",
        seconds,
      };
    });

    return {
      logline,
      soundtrack,
      scenes: heroes,
      genreId: genre?.id ?? null,
      genreLabel: genre?.label ?? null,
      editTimeline: cuts,
      masterSeconds: trackSeconds,
    };
  }

  const blocks = planHeroBlocks(target);
  const heroes: ScenePlan[] = blocks.map((seconds, i) => {
    const source = resolvedScenes[i % resolvedScenes.length]!;
    return {
      index: i,
      vocalSync: source.vocalSync === true,
      title: `Hero angle ${i + 1} — ${source.title}`,
      shot:
        `${source.shot} Camera: ${heroCameraMove(i)}. One continuous ${seconds}s take with unbroken ` +
        "motion — no static poses or held frames. Match lighting and wardrobe with the other angles.",
      seconds,
    };
  });

  return {
    logline,
    soundtrack,
    scenes: heroes,
    genreId: genre?.id ?? null,
    genreLabel: genre?.label ?? null,
    editTimeline: buildEditTimeline(heroes.length, target, null),
    masterSeconds: target,
  };

}



export type VideoJob = { id: string; status: string; progress: number; engine: VEngineId };

/**
 * Stage 3: create a render job, failing over to the backup engine on error.
 *
 * When `referenceImage` (a base64 `data:` URL) is supplied, the shot is rendered
 * image-to-video from that frame — this is what keeps a character's face and
 * wardrobe consistent from one scene block to the next.
 */
export class VisualRenderError extends Error {
  /** HTTP status returned by the render provider, when there was one. */
  status: number | null;
  /** Raw provider response body, truncated — surfaced verbatim to the operator. */
  detail: string;
  constructor(message: string, status: number | null, detail: string) {
    super(message);
    this.name = "VisualRenderError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Scripting/render stages are data-only: no raw audio ever travels into a
 * render prompt. Any audio URL or inline audio payload is stripped here.
 */
function stripAudioPayload(prompt: string): string {
  return prompt
    .replace(/data:audio\/[^\s"')]+/gi, "")
    .replace(/\b(?:blob|https?):[^\s"')]+\.(?:mp3|wav|m4a|aac|flac|ogg|opus)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Classifies a shot so it routes to the right motion node: character-led
 * performance stays on the primary cinematic engine, while wide environmental
 * and atmospheric coverage goes to the B-roll motion node.
 */
function classifyShot(
  prompt: string,
  referenceImage?: string | undefined,
): "performance" | "action" | "environment" {
  const action =
    /\b(run(?:s|ning)?|chase|sprint|fight|explosion|crash|speed|racing|jump(?:s|ing)?|whip[- ]?pan|slow[- ]?motion burst|impact|smash|dodge|leap|motorcycle|car\s|helicopter)\b/i;
  if (action.test(prompt)) return "action";
  if (referenceImage) return "performance";
  const person =
    /\b(he|she|they|him|her|artist|singer|rapper|performer|character|man|woman|crowd|dancer|face|lip[- ]?sync|walks|sings|stares|hands)\b/i;
  const wide =
    /\b(aerial|drone|skyline|landscape|cityscape|horizon|clouds|storm|rain|fog|smoke|desert|ocean|forest|empty street|establishing|b-?roll|time[- ]?lapse)\b/i;
  if (person.test(prompt)) return "performance";
  if (wide.test(prompt)) return "environment";
  return "performance";
}

export async function createVisualRender(
  prompt: string,
  seconds: 4 | 6 | 8 = 8,
  referenceImage?: string | undefined,
  genreId?: string | null,
  /**
   * Unified multimodal context for the omni-modal node: extra character/style
   * anchor images and the master audio for this shot, all conditioned in the
   * same generation pass.
   */
  context?: { styleReferences?: string[] | undefined; audioReference?: string | undefined },
): Promise<VideoJob> {
  // With a character reference the frame is an image-to-video anchor, not a
  // slide: the person in the photo must ACT inside the scene, so the model is
  // told explicitly to animate them and never hold the still frame.
  // Genre Visual Laws travel with every shot: the banned tropes for the track's
  // genre are appended as an explicit negative-prompt block on each render call.
  const law = genreLawById(genreId);
  const safePrompt = clampResolutionLanguage(stripAudioPayload(prompt));
  const lawedPrompt = law ? `${safePrompt} ${genreNegativePrompt(law)}` : safePrompt;

  const anchoredPrompt = referenceImage
    ? `${lawedPrompt} The person in the reference image is the lead character of this shot: keep their face, hair and wardrobe identical, ` +
      "and have them move and perform naturally inside the scene with a continuously moving camera. " +
      "Do not show the reference photo itself, a portrait card, a split-screen panel or any static image — this is live motion from the first frame."
    : lawedPrompt;

  const shotClass = classifyShot(safePrompt, referenceImage);

  // Pre-flight shield: reject malformed / unauthenticated jobs before a single
  // paid call goes out (no foundation frame, no motion dispatch, no credits).
  assertRenderable({
    shotId: `${genreId ?? "shot"}:${anchoredPrompt.slice(0, 24)}`,
    prompt: anchoredPrompt,
    shotClass,
    ...(referenceImage ? { referenceImage } : {}),
    ...(context?.audioReference ? { audioReference: context.audioReference } : {}),
  });

  // Stage 1 — scene keyframe. The character reference sheet is used ONLY as a
  // face-identity reference here; it is never handed to the video model as a
  // start frame (that is what produced triptych/turnaround "slides").
  const identityReferences = [referenceImage, ...(context?.styleReferences ?? [])].filter(
    (value): value is string => Boolean(value),
  );
  const sceneKeyframe =
    (await createFoundationFrame(anchoredPrompt, identityReferences)) ?? undefined;

  // Stage 2 — motion render from that single 16:9 keyframe.
  try {
    const job = await createMotionBlock({
      prompt: anchoredPrompt,
      seconds,
      referenceImage: sceneKeyframe,
      shotClass: classifyShot(safePrompt, referenceImage),
      ...(context?.audioReference ? { audioReference: context.audioReference } : {}),
    });
    return { id: job.id, status: job.status, progress: job.progress, engine: job.engine };


  } catch (error) {
    const failure = error as { message?: string; status?: number | null; detail?: string };
    throw new VisualRenderError(
      failure.message || "The visual engines are unavailable right now.",
      failure.status ?? null,
      failure.detail ?? "",
    );
  }
}



/** Raw provider lifecycle, surfaced verbatim so the UI can show a stage. */
export type RenderStage = "starting" | "processing" | "succeeded" | "failed";

export type RenderStatus = {
  status: "in_progress" | "completed" | "failed";
  /** Provider-level stage indicator for the live UI. */
  stage: RenderStage;
  progress: number;
  videoUrl: string | null;
  /** Direct provider URL — playable immediately, expires in ~1 hour. */
  previewUrl?: string | null;
  error?: string;
};

/** Polls a render job and, once complete, archives the master to private storage. */
export async function pollVisualRender(jobId: string, userId: string): Promise<RenderStatus> {
  let job;
  try {
    job = await readPrediction(jobId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Render job not found.";
    return { status: "failed", stage: "failed", progress: 0, videoUrl: null, error: reason };
  }

  if (job.status === "failed" || job.status === "canceled") {
    return {
      status: "failed",
      stage: "failed",
      progress: 0,
      videoUrl: null,
      error:
        job.error ||
        (job.status === "canceled"
          ? "The render was cancelled by the provider."
          : "The render engine failed on this block."),
    };
  }
  if (job.status !== "succeeded") {
    return {
      status: "in_progress",
      stage: job.status === "processing" ? "processing" : "starting",
      progress: predictionProgress(job),
      videoUrl: null,
    };
  }

  const source = firstOutputUrl(job.output);
  if (!source) {
    return {
      status: "failed",
      stage: "failed",
      progress: 0,
      videoUrl: null,
      error: "The render finished but returned no clip.",
    };
  }

  // The provider CDN URL is served straight to the player: no large video
  // stream is proxied or re-uploaded through the backend, so cloud compute and
  // egress stay at zero for playback.
  void userId;
  return {
    status: "completed",
    stage: "succeeded",
    progress: 100,
    videoUrl: source,
    previewUrl: source,
  };
}


// Renders are no longer re-uploaded through the backend — the player streams
// directly from the provider CDN.

