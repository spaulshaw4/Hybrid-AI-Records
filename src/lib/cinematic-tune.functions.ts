import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLocalMock } from "@/lib/local-mock";

const DIRECTIVES = [
  "cinematic",
  "tighter",
  "darker",
  "brighter",
  "action",
  "emotion",
  "detail",
  "simplify",
  "performance",
  "narrative",
  "location",
  "camera",
  "lighting",
  "symbolism",
  "hook",
  "ending",
] as const;

export type CinematicTuneDirective = (typeof DIRECTIVES)[number];

/** One-tap Co-Producer rewrite of the current cinematic script. */
export const tuneCinematicScript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      script: string;
      directive: string;
      styleMode?: string;
      subjectMode?: string;
      intensity?: number;
      instruction?: string;
    }) => {
      if (typeof data?.script !== "string" || data.script.trim().length < 40) {
        throw new Error("Add a longer script before tuning it.");
      }
      const directive = DIRECTIVES.find((d) => d === data.directive);
      if (!directive) throw new Error("Unknown adjustment.");
      const intensity = Number(data.intensity);
      return {
        script: data.script.slice(0, 15000),
        directive,
        styleMode: String(data.styleMode ?? "photorealistic").slice(0, 40),
        subjectMode: String(data.subjectMode ?? "people").slice(0, 40),
        intensity: Number.isFinite(intensity) ? Math.max(1, Math.min(5, Math.round(intensity))) : 3,
        instruction: typeof data.instruction === "string" ? data.instruction.slice(0, 600) : "",
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

      return {
        ok: true as const,
        script: `// LOCAL MOCK TUNE — directive: ${data.directive} (intensity ${data.intensity})\n${data.script}`,
      };
    }
    try {
      const { tuneScript } = await import("./cinematic-tune.server");
      const script = await tuneScript(data);
      return { ok: true as const, script };
    } catch (err) {
      console.error("Cinematic tune failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "The Co-Producer couldn't tune that script.",
      };
    }
  });
