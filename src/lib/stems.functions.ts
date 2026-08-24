import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLocalMock } from "@/lib/local-mock";

/**
 * Background stem separation for an ingested master track.
 * Returns the isolated vocal stem (lip-sync source) and the rhythmic stem
 * (downbeat source). Failures are returned, never thrown, so ingest never
 * blocks on the worker.
 */
export const separateTrackStems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { audioBase64: string; filename?: string }) => {
    if (
      typeof data?.audioBase64 !== "string" ||
      data.audioBase64.length < 1024 ||
      data.audioBase64.length > 40_000_000 ||
      !/^[A-Za-z0-9+/=]+$/.test(data.audioBase64)
    ) {
      throw new Error("Invalid master track payload");
    }
    return {
      audioBase64: data.audioBase64,
      filename: (data.filename ?? "master.mp3").slice(0, 120).replace(/[^\w.\-]/g, "_"),
    };
  })
  .handler(async ({ data }) => {
    if (isLocalMock()) {
      return { ok: true as const, vocals: null, drums: null, other: null };
    }
    try {
      const { separateStems } = await import("@/lib/stems.server");
      const binary = atob(data.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const stems = await separateStems({ audio: bytes, filename: data.filename });
      return { ok: true as const, ...stems };
    } catch (err) {
      console.error("[stems] separation failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Stem separation failed.",
      };
    }
  });
