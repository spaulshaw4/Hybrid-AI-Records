/**
 * Song-synced script writing (server only).
 *
 * The Visual Engine analyses an uploaded track in the browser and sends up
 * only its timing map (tempo, cut points, section structure). Gemini turns that
 * map — plus any seed idea or lyric sheet the user typed — into a timecoded
 * shot script whose beats land exactly on the song's musical cuts.
 */

import { aiChatFetch } from "@/lib/ai-chat.server";
import { aiTextModel } from "@/lib/ai-provider.server";
import { throwGatewayError } from "./ai-error.server";
import { producerIdentityDirective } from "@/lib/producer-identity";
import {
  CAMERA_MOVES,
  ENVIRONMENTS,
  LIGHTING_SETUPS,
  RENDER_SIGNATURES,
  SUBJECTS,
} from "@/lib/prompt-master-vocab";

/**
 * Controlled vocabulary lifted from the Prompt Master Database so every beat
 * is written with camera moves, subjects, environments and lighting the
 * downstream video engines already render reliably.
 */
function promptMasterBrief(): string {
  const list = (label: string, values: readonly string[]) =>
    `${label}: ${values.slice(0, 12).join(" | ")}`;
  return [
    "Prompt Master Database vocabulary — compose each beat from these building blocks:",
    list("Camera moves", CAMERA_MOVES),
    list("Subjects", SUBJECTS),
    list("Environments", ENVIRONMENTS),
    list("Lighting", LIGHTING_SETUPS),
    `Render signature to append to hero beats: ${RENDER_SIGNATURES[0] ?? ""}`,
    "Follow the master schema per beat: Visual: <camera move> of <subject>, <environment>, <lighting>. <render signature>",
  ].join("\n");
}

const MODEL = () => aiTextModel();

export type ScriptTimingInput = {
  durationSeconds: number;
  bpm: number | null;
  cuts: number[];
  sections: { start: number; end: number; label: string; energy: number }[];
};

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function timingBrief(timing: ScriptTimingInput): string[] {
  const lines: string[] = [
    `Track runtime: ${clock(timing.durationSeconds)} (${Math.round(timing.durationSeconds)}s).`,
    timing.bpm ? `Tempo: ~${timing.bpm} BPM.` : "Tempo: free / undetected.",
  ];
  if (timing.sections.length) {
    lines.push(
      "Song structure (start → end, energy 0-1): " +
        timing.sections
          .map(
            (s) =>
              `${s.label} ${clock(s.start)}→${clock(s.end)} (energy ${s.energy.toFixed(2)})`,
          )
          .join("; "),
    );
  }
  if (timing.cuts.length) {
    lines.push(
      `Musical cut points in seconds (every scene MUST change on one of these): ${timing.cuts
        .slice(0, 60)
        .map((c) => c.toFixed(1))
        .join(", ")}`,
    );
  }
  return lines;
}

export async function writeSyncedScript(input: {
  timing: ScriptTimingInput | null;
  seed: string;
  lyrics: string;
  styleMode: string;
  subjectMode: string;
  mode: "write" | "analyze";
  /** Character Builder directive injected into every beat. */
  characterDirective?: string;
  /** Genre Visual Laws (allowed worlds, wardrobe, lighting + negatives). */
  genreDirective?: string;
}): Promise<string> {

  const system =
    input.mode === "analyze"
      ? "You are a music-video director analysing a song. Return ONLY a tight breakdown: " +
        "the emotional arc, the visual world it implies, the key moments to hit, and a " +
        "one-line concept. No markdown fences, no headings deeper than a single line label."
      : "You are a music-video director writing a shot script that is locked to a song. " +
        "Return ONLY the script text — no preamble, no commentary, no markdown fences. " +
        "Write it as timecoded beats in the form `[0:00-0:07] SHOT — description`, one per " +
        "musical cut, covering the entire runtime. Each beat names the location, subject " +
        "action, camera move and lighting in one dense sentence. Keep characters, wardrobe " +
        "and world consistent across every beat, and escalate the imagery with the song's " +
        "energy so choruses and drops carry the hero visuals.";

  const user = [
    producerIdentityDirective(),
    ...(input.timing ? timingBrief(input.timing) : ["No audio analysis supplied."]),
    promptMasterBrief(),
    `Visual style: ${input.styleMode}. Subject mode: ${input.subjectMode}.`,
    ...(input.genreDirective?.trim() ? [input.genreDirective.trim()] : []),
    ...(input.characterDirective?.trim() ? [input.characterDirective.trim()] : []),
    ...(input.seed.trim() ? [`Director's seed idea: ${input.seed.trim().slice(0, 4000)}`] : []),
    ...(input.lyrics.trim() ? ["Lyrics / existing notes:", input.lyrics.trim().slice(0, 8000)] : []),
    input.mode === "write"
      ? "Write the full timecoded script now. Aim for 6000-12000 characters."
      : "Give the breakdown now, under 1200 characters.",
  ].join("\n");

  const response = await aiChatFetch(
    {
      body: JSON.stringify({
        model: MODEL(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    // Reasoning passes run long — the deadline is a safety net, not a budget.
    { label: "Script writer", timeoutMs: 600_000, retries: 2, baseDelayMs: 2000 },
  );

  if (!response.ok) await throwGatewayError(response, "Script writer");

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
  const clean = text.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  if (clean.length < 40) throw new Error("The script writer returned nothing. Try again.");
  return clean.slice(0, 15000);
}
