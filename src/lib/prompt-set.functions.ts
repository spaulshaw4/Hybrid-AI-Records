import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sanitizeCharacterProfile } from "@/lib/character-profile";
import type { PromptSet } from "@/lib/prompt-set.server";
import { isLocalMock, mockPromptSet } from "@/lib/local-mock";

export type PromptSetResult = ({ ok: true } & PromptSet) | { ok: false; error: string };

/**
 * Generates a style-locked prompt set from the uploaded track's detected audio
 * profile and lyrics. Free — no V Tokens are charged and nothing renders.
 */
export const generateTrackPromptSet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      lyrics: string;
      styleMode?: string;
      subjectMode?: string;
      genreId?: string | null;
      moodOverride?: string;
      count?: number;
      track?: { name?: string; bpm?: number | null; durationSeconds?: number; sections?: string[] };
      character?: {
        name?: string;
        archetype?: string;
        appearance?: string;
        referenceImage?: string | null;
      } | null;
    }) => {
      if (typeof data?.lyrics !== "string" || data.lyrics.trim().length < 10) {
        throw new Error("Add the lyrics or a song breakdown before generating prompts.");
      }
      const track = data.track ?? {};
      return {
        lyrics: data.lyrics.slice(0, 15000),
        styleMode: String(data.styleMode ?? "photorealistic").slice(0, 40),
        subjectMode: String(data.subjectMode ?? "people").slice(0, 40),
        genreId: typeof data.genreId === "string" ? data.genreId.slice(0, 40) : null,
        moodOverride: typeof data.moodOverride === "string" ? data.moodOverride.slice(0, 300) : "",
        count:
          typeof data.count === "number" && Number.isFinite(data.count)
            ? Math.max(4, Math.min(40, Math.round(data.count)))
            : 12,
        track: {
          name: typeof track.name === "string" ? track.name.slice(0, 160) : undefined,
          bpm: typeof track.bpm === "number" && Number.isFinite(track.bpm) ? track.bpm : null,
          durationSeconds:
            typeof track.durationSeconds === "number" && Number.isFinite(track.durationSeconds)
              ? track.durationSeconds
              : undefined,
          sections: Array.isArray(track.sections)
            ? track.sections
                .filter((s): s is string => typeof s === "string")
                .slice(0, 24)
                .map((s) => s.slice(0, 80))
            : [],
        },
        character: sanitizeCharacterProfile(data.character),
      };
    },
  )
  .handler(async ({ data }): Promise<PromptSetResult> => {
    if (isLocalMock()) return { ok: true as const, ...mockPromptSet(data.count) };
    try {
      const { buildPromptSet } = await import("@/lib/prompt-set.server");
      const set = await buildPromptSet(data);
      return { ok: true as const, ...set };
    } catch (err) {
      console.error("Prompt set failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "The prompt set failed. Try again.",
      };
    }
  });
