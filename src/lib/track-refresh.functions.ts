import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Repairs an expired track preview link, re-hosting the audio when still available. */
export const refreshTrackAudioUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { audioUrl: string }) => {
    const url = String(input?.audioUrl ?? "").trim();
    if (!/^https:\/\//i.test(url)) throw new Error("A valid track URL is required.");
    return { audioUrl: url };
  })
  .handler(async ({ data, context }) => {
    const { refreshTrackAudio } = await import("./track-refresh.server");
    return refreshTrackAudio(data.audioUrl, context.userId);
  });
