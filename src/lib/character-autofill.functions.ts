import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLocalMock, mockCharacterProfile } from "@/lib/local-mock";

/** Gemini fills in the Character Builder from the reference photo + track info. */
export const autoFillCharacterProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      referenceImage?: string | null;
      trackTitle?: string;
      genre?: string;
      styleMode?: string;
      notes?: string;
    }) => {
      const image =
        typeof data?.referenceImage === "string" &&
        /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(data.referenceImage) &&
        data.referenceImage.length <= 3_000_000
          ? data.referenceImage
          : null;
      return {
        referenceImage: image,
        trackTitle: String(data?.trackTitle ?? "").slice(0, 160),
        genre: String(data?.genre ?? "").slice(0, 60),
        styleMode: String(data?.styleMode ?? "").slice(0, 60),
        notes: String(data?.notes ?? "").slice(0, 1200),
      };
    },
  )
  .handler(async ({ data }) => {
    if (isLocalMock()) {
      return { ok: true as const, profile: mockCharacterProfile(data.trackTitle) };
    }
    try {
      const { autoFillCharacter } = await import("./character-autofill.server");
      const profile = await autoFillCharacter(data);
      return { ok: true as const, profile };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Auto-fill failed. Try again.",
      };
    }
  });
