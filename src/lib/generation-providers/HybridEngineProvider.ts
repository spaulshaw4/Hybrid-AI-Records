/**
 * Concrete provider: full Hybrid Engine pipeline (Gates 1–6).
 *
 * Default production backend — uses the existing `runGenerateEngineTrack`
 * orchestration while still conforming to AudioGenerationProvider so the
 * worker stays vendor-agnostic.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  AudioGenerationProvider,
  type GenerationRequestPayload,
  type GenerationResult,
} from "@/lib/generation-providers/AudioGenerationProvider";

export class HybridEngineProvider extends AudioGenerationProvider {
  readonly name = "hybrid-engine";

  async generateTrack(payload: GenerationRequestPayload): Promise<GenerationResult> {
    const { parseGenerateEngineTrackInput, runGenerateEngineTrack } = await import(
      "@/lib/apiframe-music.functions"
    );
    const { tryGetSupabaseAdmin, createSupabaseUserClient } = await import(
      "@/integrations/supabase/client.server"
    );

    const options = payload.options ?? {};
    const studioPayload =
      options.studioPayload !== undefined
        ? options.studioPayload
        : {
            prompt: payload.prompt,
            ...options,
          };

    const data = parseGenerateEngineTrackInput(studioPayload);
    const admin = tryGetSupabaseAdmin();
    const supabase =
      (options.supabase as SupabaseClient<Database> | undefined) ??
      admin ??
      createSupabaseUserClient("");

    const raw = await runGenerateEngineTrack(data, {
      userId: payload.userId,
      supabase,
    });

    const stems = (raw.stems ?? {}) as {
      masterUrl?: unknown;
      instrumentalUrl?: unknown;
      vocalUrl?: unknown;
      rawAudioUrl?: unknown;
    };
    const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
    const firstTrack = tracks[0] as { audioUrl?: unknown; duration?: unknown } | undefined;

    const audioUrl =
      (typeof stems.masterUrl === "string" && stems.masterUrl.trim()) ||
      (typeof firstTrack?.audioUrl === "string" && firstTrack.audioUrl.trim()) ||
      "";

    if (!audioUrl) {
      throw new Error("Hybrid engine completed without a playable master URL.");
    }

    const durationSeconds =
      typeof firstTrack?.duration === "number"
        ? firstTrack.duration
        : typeof raw.durationSeconds === "number"
          ? raw.durationSeconds
          : undefined;

    return {
      audioUrl,
      durationSeconds,
      title: data.title || "Untitled Track",
      style: (data.genre || data.style || data.prompt || payload.prompt).trim(),
      taskId: typeof raw.taskId === "string" ? raw.taskId : null,
      vaultId: typeof raw.vaultId === "string" ? raw.vaultId : null,
      instrumentalUrl: typeof stems.instrumentalUrl === "string" ? stems.instrumentalUrl : null,
      vocalUrl: typeof stems.vocalUrl === "string" ? stems.vocalUrl : null,
      rawAudioUrl: typeof stems.rawAudioUrl === "string" ? stems.rawAudioUrl : null,
      providerMetadata: {
        provider: this.name,
        taskId: raw.taskId,
        vaultId: raw.vaultId,
        status: raw.status,
      },
      rawResult: raw as Record<string, unknown>,
    };
  }
}
