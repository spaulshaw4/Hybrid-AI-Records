/**
 * Track length options for the Hybrid Audio Studio.
 *
 * Each option contributes (a) style directives appended to the MiniMax prompt
 * and (b) structural arrangement tags injected into the lyric block, so short
 * lyrics still render a full-length arrangement instead of ending early.
 */

export type TrackLengthId = "radio" | "extended" | "epic";

export type TrackLengthOption = {
  id: TrackLengthId;
  label: string;
  hint: string;
  /** Style tags appended to the engine prompt. */
  styleTags: string;
};

export const TRACK_LENGTHS: TrackLengthOption[] = [
  {
    id: "radio",
    label: "Radio Mix",
    hint: "~3:00",
    styleTags: "radio edit arrangement, tight 3 minute single structure",
  },
  {
    id: "extended",
    label: "Extended / Video Length",
    hint: "3:30 – 4:00",
    styleTags:
      "extended arrangement, minimum 3:30 duration, full intro and outro, instrumental solo section",
  },
  {
    id: "epic",
    label: "Epic / Full Album Version",
    hint: "5:00+",
    styleTags:
      "epic full album version, 5 minute plus runtime, dual verses, extended bridge, featured solo section, long fade outro",
  },
];

export const DEFAULT_TRACK_LENGTH: TrackLengthId = "extended";

/** Numeric target duration constraints (seconds). */
export const MIN_TARGET_DURATION_SECONDS = 150; // 2:30
export const MAX_TARGET_DURATION_SECONDS = 420; // 7:00
export const TARGET_DURATION_STEP_SECONDS = 15;
export const DEFAULT_TARGET_DURATION_SECONDS = 240; // 4:00

export function trackLengthOption(id: TrackLengthId): TrackLengthOption {
  return TRACK_LENGTHS.find((o) => o.id === id) ?? TRACK_LENGTHS[1]!;
}

/** Format a duration in seconds as mm:ss. */
export function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(
    MIN_TARGET_DURATION_SECONDS,
    Math.min(MAX_TARGET_DURATION_SECONDS, Math.round(totalSeconds)),
  );
  const m = Math.floor(clamped / 60);
  const s = Math.floor(clamped % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Snap a raw duration to the nearest allowed 15-second step. */
export function snapTargetDuration(seconds: number): number {
  const steps = Math.round((seconds - MIN_TARGET_DURATION_SECONDS) / TARGET_DURATION_STEP_SECONDS);
  const clamped = Math.max(0, Math.min(steps, (MAX_TARGET_DURATION_SECONDS - MIN_TARGET_DURATION_SECONDS) / TARGET_DURATION_STEP_SECONDS));
  return MIN_TARGET_DURATION_SECONDS + clamped * TARGET_DURATION_STEP_SECONDS;
}

/** Map a numeric target duration to the closest legacy track-length category. */
export function durationToTrackLengthId(seconds: number): TrackLengthId {
  if (seconds <= 180) return "radio";
  if (seconds <= 270) return "extended";
  return "epic";
}

/** Arrangement tags each length expects, in playing order. */
const ARRANGEMENTS: Record<TrackLengthId, string[]> = {
  radio: ["[Verse 1]", "[Chorus]", "[Verse 2]", "[Chorus]", "[Outro]"],
  extended: [
    "[Intro]",
    "[Verse 1]",
    "[Chorus]",
    "[Verse 2]",
    "[Chorus]",
    "[Bridge]",
    "[Instrumental Solo]",
    "[Chorus]",
    "[Outro]",
  ],
  epic: [
    "[Intro]",
    "[Verse 1]",
    "[Chorus]",
    "[Verse 2]",
    "[Chorus]",
    "[Extended Bridge]",
    "[Featured Solo Section]",
    "[Verse 3]",
    "[Chorus]",
    "[Long Outro]",
  ],
};

/** Filler tags used when the user's lyrics are too short to fill the runtime. */
const FILLERS = ["[Extended Instrumental Interlude]", "[Guitar Solo / Synth Breakdown]"];

/** Rough words-per-minute of sung lyrics, used to estimate runtime. */
const WORDS_PER_MINUTE = 90;
const MIN_MINUTES: Record<TrackLengthId, number> = { radio: 2.6, extended: 3.5, epic: 5 };

function tagOf(line: string): string | null {
  const m = line.trim().match(/^\[([^\]]+)\]$/);
  return m ? m[1]!.trim().toLowerCase() : null;
}

/**
 * Applies the arrangement for the chosen length to the lyric payload:
 * missing structural tags are appended, and short lyric bodies are padded
 * with instrumental interlude / solo tags so the track never ends prematurely.
 */
export function arrangeLyricsForLength(lyrics: string, id: TrackLengthId): string {
  const text = lyrics.trim();
  if (!text) return "";

  const lines = text.split("\n");
  const present = new Set(lines.map(tagOf).filter(Boolean) as string[]);

  const out = [...lines];
  const push = (tag: string) => {
    if (present.has(tag.slice(1, -1).toLowerCase())) return;
    present.add(tag.slice(1, -1).toLowerCase());
    if (out[out.length - 1]?.trim()) out.push("");
    out.push(tag);
  };

  for (const tag of ARRANGEMENTS[id]) push(tag);

  // Pad short lyric bodies so the arrangement still fills the target runtime.
  const words = lines.filter((l) => !tagOf(l)).join(" ").trim().split(/\s+/).filter(Boolean).length;
  if (words / WORDS_PER_MINUTE < MIN_MINUTES[id]) {
    for (const tag of FILLERS) push(tag);
  }

  return out.join("\n").trim();
}

/** Appends the length directives to the compiled engine style prompt. */
export function applyLengthToPrompt(prompt: string, id: TrackLengthId): string {
  return [prompt, trackLengthOption(id).styleTags].filter(Boolean).join(" | ");
}

/** Numeric-duration variant: precise target length + derived category tags. */
export function applyDurationToPrompt(prompt: string, seconds: number): string {
  const id = durationToTrackLengthId(seconds);
  const formatted = formatDuration(seconds);
  const base = trackLengthOption(id).styleTags;
  return [prompt, `target duration ${formatted} minutes`, base].filter(Boolean).join(" | ");
}

/** Numeric-duration variant of the lyric arranger. */
export function arrangeLyricsForDuration(lyrics: string, seconds: number): string {
  return arrangeLyricsForLength(lyrics, durationToTrackLengthId(seconds));
}

