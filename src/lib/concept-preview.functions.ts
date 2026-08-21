import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ConceptPreview } from "@/lib/concept-preview.server";
import { sanitizeCharacterProfile } from "@/lib/character-profile";
import { isLocalMock, mockConceptPreview } from "@/lib/local-mock";

export type ConceptPreviewResult =
  | ({ ok: true } & ConceptPreview)
  | { ok: false; error: string };

/**
 * Builds the pre-render Video Moodboard: concept frames, style tags and the
 * narrative/visual description a producer approves before paying for a render.
 * Free — no V Tokens are charged here.
 */
export const buildCinematicConcept = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      script: string;
      subjectMode: string;
      styleMode: string;
      durationSeconds: number;
      moodBoard?: { grade?: string; references?: string[]; notes?: string };
      genreId?: string | null;
      moodOverride?: string;
      track?: { name?: string; bpm?: number | null; durationSeconds?: number; sections?: string[] };
      character?: {
        name?: string;
        archetype?: string;
        appearance?: string;
        referenceImage?: string | null;
      } | null;
    }) => {
      if (typeof data?.script !== "string" || data.script.trim().length < 40) {
        throw new Error("Add a longer script before previewing the concept.");
      }
      const mood = data.moodBoard ?? {};
      const track = data.track ?? {};
      return {
        script: data.script.slice(0, 15000),
        subjectMode: String(data.subjectMode ?? "people").slice(0, 40),
        styleMode: String(data.styleMode ?? "photorealistic").slice(0, 40),
        durationSeconds:
          typeof data.durationSeconds === "number" && Number.isFinite(data.durationSeconds)
            ? Math.max(10, Math.min(3600, data.durationSeconds))
            : 210,
        genreId: typeof data.genreId === "string" ? data.genreId.slice(0, 40) : null,
        moodOverride: typeof data.moodOverride === "string" ? data.moodOverride.slice(0, 300) : "",
        track: {
          name: typeof track.name === "string" ? track.name.slice(0, 160) : undefined,
          bpm: typeof track.bpm === "number" && Number.isFinite(track.bpm) ? track.bpm : null,
          durationSeconds:
            typeof track.durationSeconds === "number" && Number.isFinite(track.durationSeconds)
              ? track.durationSeconds
              : undefined,
          sections: Array.isArray(track.sections)
            ? track.sections.filter((s): s is string => typeof s === "string").slice(0, 24).map((s) => s.slice(0, 80))
            : [],
        },
        character: sanitizeCharacterProfile(data.character),
        moodBoard: {
          grade: typeof mood.grade === "string" ? mood.grade.slice(0, 40) : undefined,
          references: Array.isArray(mood.references)
            ? mood.references
                .filter((r): r is string => typeof r === "string")
                .slice(0, 20)
                .map((r) => r.slice(0, 40))
            : [],
          notes: typeof mood.notes === "string" ? mood.notes.slice(0, 600) : "",
        },
      };
    },
  )

  .handler(async ({ data, context }): Promise<ConceptPreviewResult> => {
    if (isLocalMock()) return { ok: true as const, ...mockConceptPreview() };
    try {
      await (await import("@/lib/cinematic-access.server")).requireCinematicAccess(context.userId);
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Visual Engine is unavailable.",
      };
    }

    try {
      const { buildConceptPreview } = await import("@/lib/concept-preview.server");
      const preview = await buildConceptPreview(data);
      return { ok: true as const, ...preview };
    } catch (err) {
      console.error("Concept preview failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "The concept preview failed. Try again.",
      };
    }
  });
