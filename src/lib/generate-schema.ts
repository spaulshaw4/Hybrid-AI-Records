/**
 * Studio generate Zod schema — shared by In-Gate flux coating and API handlers.
 *
 * Kept in a leaf module (no TanStack / server-fn imports) so PipelineFluxCoating
 * can load without pulling apiframe-music.functions and hitting a TDZ cycle.
 */

import { z } from "zod";
import {
  MIN_BPM,
  MAX_BPM,
  MIN_INFLUENCE,
  MAX_INFLUENCE,
  MIN_WEIRDNESS,
  MAX_WEIRDNESS,
  MIN_STYLE_INFLUENCE,
  MAX_STYLE_INFLUENCE,
} from "@/lib/engine-controls";
import { lyricLanguageFieldSchema } from "@/lib/lyric-languages";
import { MINIMAX_MAX_SECONDS } from "@/lib/engine-routing";

export const SUNO_MODELS = ["V3_5", "V4", "V4_5"] as const;

/**
 * Advanced controls arrive as discrete numbers and are bounds-checked here.
 * The prompt directives are composed server-side so the browser can never
 * inject arbitrary directive text through these fields.
 */
const controlsSchema = z.object({
  bpm: z.number().int().min(MIN_BPM).max(MAX_BPM),
  influence: z.number().int().min(MIN_INFLUENCE).max(MAX_INFLUENCE),
  weirdness: z.number().int().min(MIN_WEIRDNESS).max(MAX_WEIRDNESS),
  styleInfluence: z.number().int().min(MIN_STYLE_INFLUENCE).max(MAX_STYLE_INFLUENCE),
});

/** Studio generate payload — also the In-Gate flux shield surface. */
export const generateSchema = z.object({
  prompt: z.string().trim().min(3).max(6000),
  title: z.string().trim().max(120).default(""),
  style: z.string().trim().max(6000).default(""),
  lyrics: z.string().trim().max(6000).default(""),
  // Full AI track (vocals) by default; true renders an instrumental backing track.
  instrumental: z.boolean().default(false),

  audioFormat: z.enum(["mp3", "wav"]).default("mp3"),
  /** Optional cloned voice from the artist's Voice Library. */
  voiceId: z.string().trim().max(200).optional(),
  /** Studio legal-disclaimer checkbox. Required when cloning a custom voice. */
  termsAccepted: z.boolean().default(false),
  /**
   * Target lyric language. Drives pronunciation, diacritic handling and accent
   * in the engine prompt. Defaults to English so the form is never empty.
   */
  language: lyricLanguageFieldSchema,
  customLanguage: z.string().trim().max(60).default(""),
  customMode: z.boolean().default(false),
  /**
   * Sonic custom-mode tags: genre chips plus the artist's freeform style
   * prompt, passed through verbatim. The ceiling is a transport guard only —
   * never trim or rewrite descriptors the artist typed.
   */
  tags: z.string().trim().max(6000).optional(),
  /** Sonic model version. Studio Step 2 locks to sonic-v5. */
  mv: z.string().trim().max(40).optional(),
  model: z.enum(SUNO_MODELS).default("V4_5"),
  /** Ignored. Kept so older clients that still send an engine id do not 400. */
  engine: z.enum(["minimax", "hybrid", "elevenlabs"]).optional(),
  /** Target length in seconds. Clamped to the master ceiling on the server. */
  durationSeconds: z.number().int().min(10).max(MINIMAX_MAX_SECONDS).optional(),
  /** Ignored. Kept for older clients. */
  allowReslice: z.boolean().optional(),
  controls: controlsSchema.optional(),
  /** Core style/genre tags from the studio — not rewritten to a stock genre. */
  genre: z.string().trim().max(6000).optional(),
  subGenre: z.string().trim().max(6000).optional(),
  mood: z.string().trim().max(400).optional(),
  instruments: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  /** Default-AI vocal character (Aggressive Rock Vocal, Female Vocal, …). */
  vocalProfile: z.string().trim().max(400).optional(),
  vocalGender: z.string().trim().max(40).optional(),
  vocalTimbre: z.string().trim().max(400).optional(),
  vocalStyle: z.string().trim().max(400).optional(),
  /** Direct sample URL when the client already resolved the cloned take. */
  referenceAudioUrl: z.string().trim().max(2000).optional(),
  /** Browser MediaRecorder blob as base64 (WebM/Opus). Worker transcodes to WAV. */
  vocalAudioBase64: z.string().trim().max(12_000_000).optional(),
  vocalFileName: z.string().trim().max(180).optional(),
  /**
   * Artist RVC v2 model zip (HTTPS). Gate 5 uses this with
   * zsxkib/realistic-voice-cloning for pitch-preserving voice conversion.
   */
  rvcModelUrl: z.string().trim().max(2000).optional(),
  /** Open `user_vault` row to flip from processing → completed. */
  vaultId: z.preprocess((value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
      ? trimmed
      : undefined;
  }, z.string().uuid().optional()),
  /** Same key the studio uses to charge on Generate, so a retry cannot double-spend. */
  idempotencyKey: z.string().trim().max(120).optional(),
  /** Correlation id stamped by the cortex dispatcher (worker / logs). */
  cortexCorrelationId: z.string().trim().max(80).optional(),
});

export type GenerateEngineTrackInput = z.infer<typeof generateSchema>;

export function parseGenerateEngineTrackInput(data: unknown): GenerateEngineTrackInput {
  const parsed = generateSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path?.length ? issue.path.join(".") : "payload";
  throw new Error(`Track setup: ${path} ${issue?.message ?? "was out of range"}`);
}
