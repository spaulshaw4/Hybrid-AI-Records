/**
 * Concept preview (server only).
 *
 * Builds the "Video Moodboard" shown right before a render is paid for:
 * a logline, a full narrative/visual description, style tags and a set of
 * preview frames (character close-ups and environmental framing) rendered as
 * still images. Nothing here charges V Tokens — it is the approval step.
 */

import { moodBoardDirection, styleLabelFor, styleDirectionFor, type MoodBoard } from "@/lib/visual-styles";
import { aiChatFetch } from "@/lib/ai-chat.server";
import { aiChatUrl, aiHeaders, aiImageModel, aiTextModel } from "@/lib/ai-provider.server";
import {
  detectGenreLaw,
  genreDirective,
  genreLawById,
  genreNegativePrompt,
  scrubShotForGenre,
} from "@/lib/cinematic-genre";
import {
  characterDirective,
  characterDisplayName,
  hasCharacterProfile,
  type CharacterProfile,
} from "@/lib/character-profile";
import { throwGatewayError } from "./ai-error.server";





export type ConceptFrame = {
  id: string;
  kind: "character" | "environment";
  title: string;
  description: string;
  image: string | null;
};

export type ConceptPreview = {
  logline: string;
  narrative: string;
  styleTags: string[];
  frames: ConceptFrame[];
};


async function generateFrameImage(prompt: string): Promise<string | null> {
  try {
    const response = await aiChatFetch(
      {
        body: JSON.stringify({
          model: aiImageModel(),
          modalities: ["image", "text"],
          messages: [{ role: "user", content: prompt.slice(0, 1200) }],
        }),
      },
      { label: "Concept frame", retries: 0, tier: "paid" },
    );

    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
    };
    return payload.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? null;
  } catch {
    return null;
  }
}

type ParsedConcept = {
  logline?: unknown;
  narrative?: unknown;
  styleTags?: unknown;
  frames?: Array<Record<string, unknown>>;
};

/**
 * Robust JSON extraction: strips markdown fences and any conversational
 * preamble/epilogue before parsing. Returns null when nothing parses.
 */
export function extractConceptJson(rawResponse: string): ParsedConcept | null {
  let cleaned = (rawResponse ?? "").trim();
  if (!cleaned) return null;

  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const attempt = (text: string): ParsedConcept | null => {
    try {
      const value = JSON.parse(text) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? (value as ParsedConcept) : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(cleaned);
  if (direct) return direct;

  const match = cleaned.match(/\{[\s\S]*\}/);
  return match ? attempt(match[0]) : null;
}

/** Deterministic frames built from the producer's own inputs when the model output is unusable. */
function fallbackFrames(opts: {
  styleMode: string;
  mood: string;
  wantsPeople: boolean;
  character: CharacterProfile | null;
}): ConceptFrame[] {
  const look = styleDirectionFor(opts.styleMode);
  const grade = opts.mood ? ` Colour grade: ${opts.mood}.` : "";
  const lead = hasCharacterProfile(opts.character)
    ? `${characterDisplayName(opts.character!)}${opts.character?.appearance ? ` — ${opts.character.appearance}` : ""}`
    : "the lead performer";

  const specs: Array<{ kind: ConceptFrame["kind"]; title: string; description: string }> = opts.wantsPeople
    ? [
        {
          kind: "character",
          title: "Lead close-up",
          description: `Tight cinematic close-up of ${lead}, eyeline just off camera, soft key light with deep falloff. ${look}.${grade}`,
        },
        {
          kind: "character",
          title: "Performance mid-shot",
          description: `Mid-shot of ${lead} performing to camera, subtle handheld drift, practical lights behind. ${look}.${grade}`,
        },
        {
          kind: "environment",
          title: "Establishing wide",
          description: `Wide establishing shot of the song's primary location, atmospheric haze, strong depth layers. ${look}.${grade}`,
        },
        {
          kind: "environment",
          title: "Texture insert",
          description: `Slow macro insert on a defining texture of the location — surface detail, reflected light, shallow focus. ${look}.${grade}`,
        },
      ]
    : [
        {
          kind: "environment",
          title: "Establishing wide",
          description: `Wide establishing shot of the song's primary location, no people on screen, atmospheric depth. ${look}.${grade}`,
        },
        {
          kind: "environment",
          title: "Architectural detail",
          description: `Static composition on structure and line — geometry, shadow, negative space, no people. ${look}.${grade}`,
        },
        {
          kind: "environment",
          title: "Motion element",
          description: `Slow drifting shot across a moving element (light, water, dust, traffic), no people. ${look}.${grade}`,
        },
        {
          kind: "environment",
          title: "Closing frame",
          description: `Final wide frame at the emotional peak of the track, empty landscape, fading light. ${look}.${grade}`,
        },
      ];

  return specs.map((spec, index) => ({ id: `frame-${index}`, ...spec, image: null }));
}


export type ConceptTrackContext = {
  /** Uploaded file / track name, when known. */
  name?: string | undefined;
  /** Detected tempo. */
  bpm?: number | null | undefined;
  /** Track length in seconds. */
  durationSeconds?: number | undefined;
  /** Structural map: "intro 0-12s (energy 0.2)", … */
  sections?: string[] | undefined;
};

export async function buildConceptPreview(input: {
  script: string;
  subjectMode: string;
  styleMode: string;
  durationSeconds: number;
  moodBoard?: MoodBoard | undefined;
  /** Manual genre law id; falls back to detection from the lyrics/script. */
  genreId?: string | null | undefined;
  /** Manual mood override typed by the producer. */
  moodOverride?: string | undefined;
  /** Metadata read from the uploaded audio track. */
  track?: ConceptTrackContext | undefined;
  /** Character Builder profile: the mandated lead subject. */
  character?: CharacterProfile | null | undefined;
}): Promise<ConceptPreview> {
  const mood = moodBoardDirection(input.moodBoard);
  const wantsPeople = input.subjectMode === "people" || input.subjectMode === "story";
  const law =
    genreLawById(input.genreId) ??
    detectGenreLaw(input.script, `${input.track?.name ?? ""} ${input.moodOverride ?? ""}`);

  const trackLines: string[] = [];
  if (input.track?.name) trackLines.push(`Track: ${input.track.name}.`);
  if (input.track?.bpm) trackLines.push(`Detected tempo: ${Math.round(input.track.bpm)} BPM.`);
  if (input.track?.durationSeconds)
    trackLines.push(`Track length: ${Math.round(input.track.durationSeconds)}s.`);
  if (input.track?.sections?.length)
    trackLines.push(`Song structure: ${input.track.sections.slice(0, 24).join("; ")}.`);

  const response = await aiChatFetch({
    body: JSON.stringify({
      model: aiTextModel(),
      messages: [
        {
          role: "system",
          content:
            "You are a music-video concept director. From THIS track's lyrics, metadata and genre, produce the " +
            "concept board a director would approve before the shoot. Never reuse stock characters, stock names or " +
            "template concepts — every character name, look and location must come from this song's own lyrics. " +
            "Respond with strictly valid JSON only. Do not include markdown code fences, backticks, or any " +
            "introductory or concluding text. Shape: " +
            '{"logline":string,"narrative":string,"styleTags":string[],"frames":[{"kind":"character"|"environment","title":string,"description":string}]}. ' +
            "`narrative` is 120-200 words covering story, look, colour, lensing and progression. " +
            "`styleTags` are 6-10 short craft tags such as \"golden-hour anamorphic\", \"sun-flare drenched\", \"35mm film grain\". " +
            "Return exactly 4 frames; each `description` is a self-contained still-image prompt.",
        },
        {
          role: "user",
          content: [
            `Runtime: ${Math.round(input.durationSeconds)}s.`,
            ...trackLines,
            `Visual style: ${styleLabelFor(input.styleMode)} — ${styleDirectionFor(input.styleMode)}.`,
            ...(mood ? [`Mood board: ${mood}.`] : []),
            ...(input.moodOverride?.trim() ? [`Mood override (mandatory): ${input.moodOverride.trim()}.`] : []),
            ...(law ? [genreDirective(law), genreNegativePrompt(law)] : []),
            ...(hasCharacterProfile(input.character)
              ? [
                  characterDirective(input.character),
                  `Both character frames must depict ${characterDisplayName(
                    input.character!,
                  )} exactly as described — never invent another lead or another name.`,
                ]
              : []),
            wantsPeople
              ? "Frames: 2 character close-ups (lead performers named and described from the lyrics, consistent faces and wardrobe) and 2 environmental framing shots."
              : "Frames: 4 environmental framing shots, no people on screen.",
            "Lyrics / script:",
            input.script.slice(0, 15000),
          ].join("\n"),
        },
      ],
    }),
  }, { label: "Concept board", tier: "paid" });



  if (!response.ok) await throwGatewayError(response, "Concept board");

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = payload.choices?.[0]?.message?.content?.trim() ?? "";

  const parsed = extractConceptJson(raw) ?? {};

  let frames = (Array.isArray(parsed.frames) ? parsed.frames : [])
    .slice(0, 4)
    .map((frame, index) => ({
      id: `frame-${index}`,
      kind: (frame["kind"] === "character" ? "character" : "environment") as ConceptFrame["kind"],
      title: String(frame["title"] ?? `Frame ${index + 1}`).slice(0, 90),
      description: scrubShotForGenre(String(frame["description"] ?? ""), law).slice(0, 900),
      image: null as string | null,
    }))
    .filter((frame) => frame.description.length > 0);

  // Graceful fallback: never hard-fail the preview — build a usable concept from
  // the producer's own inputs (style, mood, genre, character).
  if (frames.length === 0) {
    console.warn("[concept board] unreadable model output — using fallback concept");
    frames = fallbackFrames({
      styleMode: input.styleMode,
      mood,
      wantsPeople,
      character: input.character ?? null,
    }).map((frame) => ({
      ...frame,
      description: scrubShotForGenre(frame.description, law).slice(0, 900),
    }));
  }


  const styleTags = (
    Array.isArray(parsed.styleTags)
      ? parsed.styleTags
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          .slice(0, 10)
          .map((t) => t.trim().slice(0, 40))
      : []
  );
  const resolvedStyleTags = styleTags.length
    ? styleTags
    : [styleLabelFor(input.styleMode), ...(mood ? [mood.slice(0, 40)] : []), "cinematic 16:9", "shallow depth of field"];


  const grade = mood ? ` Colour grade and references: ${mood}.` : "";
  const characterLine = hasCharacterProfile(input.character)
    ? ` Lead character: ${characterDisplayName(input.character!)}${
        input.character!.appearance ? ` — ${input.character!.appearance}` : ""
      }.`
    : "";
  const negative = law ? ` ${genreNegativePrompt(law)}` : "";
  const images = await Promise.all(
    frames.map((frame) =>
      generateFrameImage(
        `Cinematic still frame, 16:9. ${frame.description} Visual style: ${styleDirectionFor(
          input.styleMode,
        )}.${characterLine}${grade}${negative} No text, no watermark, no captions.`,
      ),
    ),
  );


  const logline =
    typeof parsed.logline === "string" && parsed.logline.trim()
      ? parsed.logline.trim().slice(0, 400)
      : `A ${styleLabelFor(input.styleMode).toLowerCase()} music video cut to the track's own arc.`;
  const narrative =
    typeof parsed.narrative === "string" && parsed.narrative.trim()
      ? parsed.narrative.trim().slice(0, 2500)
      : `Concept preview assembled from your style, mood and character settings: ${styleDirectionFor(
          input.styleMode,
        )}.${mood ? ` Colour grade and references: ${mood}.` : ""}${characterLine} Four frames cover the lead, the performance and the location so you can approve the look before any V Tokens are spent. Re-run the preview for a richer written treatment.`;

  return {
    logline,
    narrative,
    styleTags: resolvedStyleTags,
    frames: frames.map((frame, i) => ({ ...frame, image: images[i] ?? null })),
  };
}
