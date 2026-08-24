import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLocalMock } from "@/lib/local-mock";

/**
 * Lip-syncs one rendered shot against its sliced audio segment.
 * Only shots tagged `vocalSync` ever reach this function.
 */
export const lipsyncCinematicShot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { videoUrl: string; audioWavBase64: string; shotIndex: number }) => {
    if (typeof data?.videoUrl !== "string" || !/^https?:\/\//.test(data.videoUrl)) {
      throw new Error("Invalid shot video URL");
    }
    if (
      typeof data?.audioWavBase64 !== "string" ||
      data.audioWavBase64.length < 64 ||
      data.audioWavBase64.length > 24_000_000 ||
      !/^[A-Za-z0-9+/=]+$/.test(data.audioWavBase64)
    ) {
      throw new Error("Invalid audio slice");
    }
    return {
      videoUrl: data.videoUrl.slice(0, 2000),
      audioWavBase64: data.audioWavBase64,
      shotIndex: Math.max(0, Math.min(200, Math.round(Number(data.shotIndex) || 0))),
    };
  })
  .handler(async ({ data }) => {
    // Local mock mode: pass the shot straight through, no provider call.
    if (isLocalMock()) return { ok: true as const, videoUrl: data.videoUrl };
    try {
      const { lipsyncShot } = await import("@/lib/lipsync.server");
      const binary = atob(data.audioWavBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const videoUrl = await lipsyncShot({
        videoUrl: data.videoUrl,
        audioWav: bytes,
        shotIndex: data.shotIndex,
      });
      return { ok: true as const, videoUrl };
    } catch (err) {
      console.error("Lip-sync pass failed:", err);
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "The lip-sync pass failed.",
      };
    }
  });
