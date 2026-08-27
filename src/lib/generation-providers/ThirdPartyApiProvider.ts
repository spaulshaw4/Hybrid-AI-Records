/**
 * Concrete provider: shared third-party Sonic / MusicAPI key.
 *
 * Wraps the existing `generateStudioTrack` + `waitForStudioTrack` path so the
 * queue/worker never hardcodes vendor URLs. Swap via GenerationFactory when a
 * proprietary engine lands.
 */

import {
  AudioGenerationProvider,
  type GenerationRequestPayload,
  type GenerationResult,
} from "@/lib/generation-providers/AudioGenerationProvider";

export class ThirdPartyApiProvider extends AudioGenerationProvider {
  readonly name = "third-party-wrapper";

  async generateTrack(payload: GenerationRequestPayload): Promise<GenerationResult> {
    const { generateStudioTrack, waitForStudioTrack, getMusicApiKey } = await import(
      "@/lib/music-generation"
    );
    getMusicApiKey();

    const options = payload.options ?? {};
    const title =
      typeof options.title === "string" && options.title.trim()
        ? options.title.trim()
        : "Untitled Track";
    const lyrics =
      typeof options.lyrics === "string" ? options.lyrics : "";
    const instrumental = options.instrumental === true;
    const genre =
      (typeof options.genre === "string" && options.genre.trim()) ||
      (typeof options.style === "string" && options.style.trim()) ||
      payload.prompt;
    const durationSeconds =
      typeof options.durationSeconds === "number" && Number.isFinite(options.durationSeconds)
        ? Math.trunc(options.durationSeconds)
        : undefined;

    const started = await generateStudioTrack({
      genre,
      lyrics: instrumental ? "" : lyrics,
      isInstrumental: instrumental,
      title,
      tags: typeof options.tags === "string" ? options.tags : undefined,
      vocalGender: typeof options.vocalGender === "string" ? options.vocalGender : undefined,
    });

    const finished = await waitForStudioTrack(started.taskId);
    const audioUrl = finished.audioUrl?.trim();
    if (!audioUrl) {
      throw new Error("Upstream generation failed: no audio URL returned.");
    }

    return {
      audioUrl,
      durationSeconds: finished.duration ?? durationSeconds,
      title: finished.title || title,
      style: genre,
      taskId: finished.taskId || started.taskId,
      rawAudioUrl: audioUrl,
      providerMetadata: {
        provider: this.name,
        taskId: finished.taskId || started.taskId,
        status: finished.status,
      },
    };
  }
}
