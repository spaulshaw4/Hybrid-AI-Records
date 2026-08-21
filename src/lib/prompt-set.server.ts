/**
 * Style-locked prompt set (server only).
 *
 * Turns an uploaded track — its detected audio profile (tempo, length, song
 * structure) plus its lyrics — into a numbered set of shot prompts that all
 * obey the same Genre Visual Laws, visual style and Character Profile. The set
 * is free to generate: no V Tokens are charged, nothing is rendered.
 */

import { styleLabelFor, styleDirectionFor } from "@/lib/visual-styles";
import { aiChatFetch } from "@/lib/ai-chat.server";
import { aiChatUrl, aiHeaders, aiTextModel } from "@/lib/ai-provider.server";
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
import { producerIdentityDirective } from "@/lib/producer-identity";



export type TrackPrompt = {
  /** 1-based position in the set, matching the running order of the song. */
  index: number;
  /** Section of the song this shot covers, e.g. "chorus 1". */
  section: string;
  /** Start time in seconds inside the track. */
  startSeconds: number;
  /** Shot length in seconds. */
  seconds: number;
  /** Camera move / framing. */
  camera: string;
  /** The full, self-contained render prompt. */
  prompt: string;
  /** Genre-derived exclusions applied to this shot. */
  negative: string;
  /** True when the shot is a close-up that should be lip-synced. */
  vocalSync: boolean;
};

export type PromptSet = {
  /** Human label for the locked style, e.g. "Southern Gothic / Outlaw Rock". */
  styleLock: string;
  /** Craft tags shared by every prompt in the set. */
  styleTags: string[];
  /** Shared negative prompt applied to the whole set. */
  negativePrompt: string;
  prompts: TrackPrompt[];
};

export type PromptSetTrack = {
  name?: string | undefined;
  bpm?: number | null | undefined;
  durationSeconds?: number | undefined;
  /** "intro 0-12s (energy 0.2)", … */
  sections?: string[] | undefined;
};


export async function buildPromptSet(input: {
  /** Lyrics / script sheet for the uploaded track. */
  lyrics: string;
  styleMode: string;
  subjectMode: string;
  genreId?: string | null | undefined;
  moodOverride?: string | undefined;
  track?: PromptSetTrack | undefined;
  character?: CharacterProfile | null | undefined;
  /** How many prompts to produce. */
  count: number;
}): Promise<PromptSet> {
  const law =
    genreLawById(input.genreId) ??
    detectGenreLaw(input.lyrics, `${input.track?.name ?? ""} ${input.moodOverride ?? ""}`);
  const wantsPeople = input.subjectMode !== "scenery";
  const duration = Math.max(30, Math.round(input.track?.durationSeconds ?? 210));

  const trackLines: string[] = [];
  if (input.track?.name) trackLines.push(`Track: ${input.track.name}.`);
  if (input.track?.bpm) trackLines.push(`Detected tempo: ${Math.round(input.track.bpm)} BPM.`);
  trackLines.push(`Track length: ${duration}s.`);
  if (input.track?.sections?.length)
    trackLines.push(`Song structure: ${input.track.sections.slice(0, 24).join("; ")}.`);

  const response = await aiChatFetch(
    // FREE Hybrid tier — never billed against the paid key.
    {
    body: JSON.stringify({
      model: aiTextModel(),
      messages: [
        {
          role: "system",
          content:
            "You are a music-video shot designer. From THIS track's audio profile and lyrics, write a " +
            "style-locked prompt set: every prompt shares the same world, wardrobe, palette and lensing so the " +
            "shots cut together as one film. Never reuse stock characters, stock names or template concepts — " +
            "characters, locations and imagery must come from this song's own words. " +
            "Reply with JSON only: " +
            '{"styleTags":string[],"prompts":[{"section":string,"startSeconds":number,"seconds":number,' +
            '"camera":string,"prompt":string,"vocalSync":boolean}]}. ' +
            "Prompts run in the song's running order and their start times must tile the full track length " +
            "without gaps. Each `prompt` is a self-contained render prompt of 30-60 words naming camera move, " +
            "subject, environment, lighting and film stock. `vocalSync` is true only for close-ups where the " +
            "lead is singing the lyric of that moment. `styleTags` are 6-10 short craft tags.",
        },
        {
          role: "user",
          content: [
            producerIdentityDirective(),
            `Produce exactly ${input.count} prompts covering ${duration}s.`,
            ...trackLines,
            `Visual style: ${styleLabelFor(input.styleMode)} — ${styleDirectionFor(input.styleMode)}.`,
            ...(input.moodOverride?.trim()
              ? [`Mood override (mandatory): ${input.moodOverride.trim()}.`]
              : []),
            ...(law ? [genreDirective(law), genreNegativePrompt(law)] : []),
            ...(wantsPeople && hasCharacterProfile(input.character)
              ? [
                  characterDirective(input.character),
                  `Every shot with a person shows ${characterDisplayName(
                    input.character!,
                  )} exactly as described — never invent another lead or another name.`,
                ]
              : []),
            wantsPeople
              ? "Mix performance close-ups with narrative and environmental shots."
              : "No people on screen: environments, objects and landscape only.",
            "Lyrics / script:",
            input.lyrics.slice(0, 15000),
          ].join("\n"),
        },
      ],
    }),
  });

  if (!response.ok) await throwGatewayError(response, "Prompt set");

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = payload.choices?.[0]?.message?.content?.trim() ?? "";
  const json = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let parsed: { styleTags?: unknown; prompts?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The prompt set came back unreadable. Try again.");
  }

  const negative = law ? genreNegativePrompt(law) : "";
  const rows = Array.isArray(parsed.prompts) ? parsed.prompts : [];

  let cursor = 0;
  const prompts: TrackPrompt[] = rows
    .slice(0, Math.max(1, input.count))
    .map((row, index) => {
      const seconds = Math.max(2, Math.min(20, Math.round(Number(row["seconds"]) || 8)));
      const startRaw = Number(row["startSeconds"]);
      const startSeconds = Number.isFinite(startRaw) && startRaw >= 0 ? Math.round(startRaw) : cursor;
      cursor = startSeconds + seconds;
      return {
        index: index + 1,
        section: String(row["section"] ?? `shot ${index + 1}`).slice(0, 60),
        startSeconds,
        seconds,
        camera: String(row["camera"] ?? "").slice(0, 120),
        prompt: scrubShotForGenre(String(row["prompt"] ?? ""), law).slice(0, 900),
        negative,
        vocalSync: row["vocalSync"] === true,
      };
    })
    .filter((row) => row.prompt.length > 0);

  if (!prompts.length) throw new Error("The prompt set came back empty. Add lyrics and try again.");

  const styleTags = Array.isArray(parsed.styleTags)
    ? parsed.styleTags.filter((t): t is string => typeof t === "string").slice(0, 10).map((t) => t.slice(0, 40))
    : [];

  return {
    styleLock: law?.label ?? styleLabelFor(input.styleMode),
    styleTags,
    negativePrompt: negative,
    prompts,
  };
}
