import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLocalMock, MOCK_STYLE_DIRECTION } from "@/lib/local-mock";

/** Gemini tunes the look direction for the selected visual style. */
export const tuneStylePrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { styleMode?: string; script?: string; notes?: string }) => ({
    styleMode: String(data?.styleMode ?? "photorealistic").slice(0, 60),
    script: String(data?.script ?? "").slice(0, 4000),
    notes: String(data?.notes ?? "").slice(0, 1500),
  }))
  .handler(async ({ data, context }) => {
    if (isLocalMock()) return { ok: true as const, direction: MOCK_STYLE_DIRECTION };
    try {
      await (await import("@/lib/cinematic-access.server")).requireCinematicAccess(context.userId);
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Visual Engine is unavailable.",
      };
    }

    try {
      const { writeStyleDirection } = await import("./cinematic-style.server");
      const direction = await writeStyleDirection(data);
      return { ok: true as const, direction };
    } catch (err) {
      console.error("Style prompt tuning failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Style tuning failed. Try again.",
      };
    }
  });
