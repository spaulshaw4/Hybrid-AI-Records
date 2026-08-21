import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { characterDirective, sanitizeCharacterProfile } from "@/lib/character-profile";
import { genreDirective, genreLawById, genreNegativePrompt } from "@/lib/cinematic-genre";
import { isLocalMock, mockScript } from "@/lib/local-mock";

export type ScriptTimingPayload = {
  durationSeconds: number;
  bpm: number | null;
  cuts: number[];
  sections: { start: number; end: number; label: string; energy: number }[];
};

/** Gemini writes (or breaks down) a cinematic script locked to the song's timing map. */
export const generateCinematicScript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      timing?: ScriptTimingPayload | null;
      seed?: string;
      lyrics?: string;
      styleMode?: string;
      subjectMode?: string;
      mode?: string;
      character?: unknown;
      genreId?: string | null;
    }) => {
      const mode = data?.mode === "analyze" ? ("analyze" as const) : ("write" as const);
      const raw = data?.timing;
      const timing = raw
        ? {
            durationSeconds: Number(raw.durationSeconds) || 0,
            bpm: typeof raw.bpm === "number" ? raw.bpm : null,
            cuts: Array.isArray(raw.cuts) ? raw.cuts.slice(0, 120).map(Number) : [],
            sections: Array.isArray(raw.sections)
              ? raw.sections.slice(0, 24).map((s) => ({
                  start: Number(s.start) || 0,
                  end: Number(s.end) || 0,
                  label: String(s.label ?? "verse").slice(0, 20),
                  energy: Number(s.energy) || 0,
                }))
              : [],
          }
        : null;
      const seed = String(data?.seed ?? "").slice(0, 4000);
      const lyrics = String(data?.lyrics ?? "").slice(0, 8000);
      if (!timing && seed.trim().length < 10) {
        throw new Error("Drop a song or add a short idea first.");
      }
      const law = genreLawById(typeof data?.genreId === "string" ? data.genreId : null);
      return {
        timing,
        seed,
        characterDirective: characterDirective(sanitizeCharacterProfile(data?.character)),
        genreDirective: law
          ? `${genreDirective(law)} ${genreNegativePrompt(law)}`
          : "",
        lyrics,
        styleMode: String(data?.styleMode ?? "photorealistic").slice(0, 40),
        subjectMode: String(data?.subjectMode ?? "people").slice(0, 40),
        mode,
      };
    },
  )
  .handler(async ({ data, context }) => {
    if (isLocalMock()) {
    try {
      await (await import("@/lib/cinematic-access.server")).requireCinematicAccess(context.userId);
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Visual Engine is unavailable.",
      };
    }

      const seconds = data.timing?.durationSeconds || 210;
      return {
        ok: true as const,
        script:
          data.mode === "analyze"
            ? "Local mock breakdown — arc: quiet start, rising defiance, release at the chorus, worn calm at the outro. World: dawn highways, rain-lit alleys, one packed room. Concept: one last take before dawn."
            : mockScript(seconds, data.seed),
      };
    }
    try {
      const { writeSyncedScript } = await import("./cinematic-script.server");
      const script = await writeSyncedScript(data);
      return { ok: true as const, script };
    } catch (err) {
      console.error("Cinematic script generation failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "The script writer failed. Try again.",
      };
    }
  });
