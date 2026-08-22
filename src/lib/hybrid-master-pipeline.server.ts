/**
 * Server-only Hybrid Engine finish: Demucs split → Fish vocals → Matchering.
 *
 * Completed masters are uploaded only after Matchering (or its loudnorm
 * fallback) writes a premaster. Callers must not mark the job complete with
 * the raw Stage 1 mix.
 */
import { backingStemUrl } from "@/lib/stem-urls";

export type HybridMasterPipelineResult = {
  masterUrl: string | null;
  vocalUrl: string | null;
  instrumentalUrl: string | null;
  mixed: boolean;
  matched: boolean;
};

async function downloadAudioBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Could not download audio (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1024) throw new Error("Downloaded audio was empty.");
  return bytes;
}

async function archiveUrl(
  url: string | null,
  userId: string,
  taskId: string,
): Promise<string | null> {
  if (!url) return null;
  try {
    const { archiveGeneratedAudio } = await import("@/lib/apiframe.server");
    return await archiveGeneratedAudio(url, userId, taskId);
  } catch (error) {
    console.warn(
      "[pipeline] stem archive skipped",
      error instanceof Error ? error.message : error,
    );
    return url;
  }
}

/**
 * Stage 2–4 of generate: split the base mix, convert vocals on Fish Audio,
 * mix converted vocals with the Demucs backing, then Matchering-master.
 */
export async function runHybridMasterPipeline(input: {
  baseAudioUrl: string;
  lyrics: string;
  instrumental: boolean;
  referenceSampleUrl?: string;
  audioFormat?: "mp3" | "wav";
  title: string;
  userId: string;
  taskId: string;
}): Promise<HybridMasterPipelineResult> {
  let instrumentalUrl: string | null = input.instrumental ? input.baseAudioUrl : null;
  let isolatedVocalUrl: string | null = null;
  let convertedVocalUrl: string | null = null;

  try {
    const baseBytes = await downloadAudioBytes(input.baseAudioUrl);
    const { separateStems } = await import("@/lib/stems.server");
    const stems = await separateStems({
      audio: baseBytes,
      filename: `${input.taskId}-base.mp3`,
    });
    instrumentalUrl = (await archiveUrl(
      backingStemUrl(stems),
      input.userId,
      `${input.taskId}-instrumental`,
    )) ?? instrumentalUrl;
    isolatedVocalUrl = await archiveUrl(stems.vocals, input.userId, `${input.taskId}-demucs-vocals`);
  } catch (error) {
    console.warn(
      "[pipeline] Demucs split skipped",
      error instanceof Error ? error.message : error,
    );
  }

  if (!input.instrumental && input.lyrics.trim()) {
    try {
      const { convertVocalsWithStems, cloneVocalsFromSample } = await import("@/lib/fish-tts.server");
      let isolatedVocal: Uint8Array | undefined;
      if (isolatedVocalUrl) {
        isolatedVocal = await downloadAudioBytes(isolatedVocalUrl).catch(() => undefined);
      }
      const converted = input.referenceSampleUrl
        ? isolatedVocal
          ? await convertVocalsWithStems({
              lyrics: input.lyrics,
              isolatedVocal,
              referenceAudio: await downloadAudioBytes(input.referenceSampleUrl).catch(
                () => undefined,
              ),
              audioFormat: input.audioFormat,
              title: `${input.title} vocals`,
              userId: input.userId,
              taskId: `${input.taskId}-fish-vocals`,
            })
          : await cloneVocalsFromSample({
              sampleUrl: input.referenceSampleUrl,
              lyrics: input.lyrics,
              audioFormat: input.audioFormat,
              title: `${input.title} vocals`,
              userId: input.userId,
              taskId: `${input.taskId}-fish-vocals`,
            })
        : await convertVocalsWithStems({
            lyrics: input.lyrics,
            isolatedVocal,
            audioFormat: input.audioFormat,
            title: `${input.title} vocals`,
            userId: input.userId,
            taskId: `${input.taskId}-fish-vocals`,
          });
      convertedVocalUrl = converted.tracks.find((track) => track.audioUrl)?.audioUrl ?? null;
    } catch (error) {
      console.warn(
        "[pipeline] Fish Audio vocals skipped",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const vocalUrl = convertedVocalUrl ?? isolatedVocalUrl;
  const mixVocalUrl = vocalUrl ?? (instrumentalUrl ? null : input.baseAudioUrl);
  const mixInstrumentalUrl = instrumentalUrl ?? (vocalUrl ? null : input.baseAudioUrl);

  const { mixAndMasterHybridTrack } = await import("@/lib/matchering-master.server");
  const mastered = await mixAndMasterHybridTrack({
    introUrl: null,
    instrumentalUrl: mixInstrumentalUrl,
    vocalUrl: mixVocalUrl,
    userId: input.userId,
    taskId: input.taskId,
  });

  return {
    masterUrl: mastered.masterUrl,
    vocalUrl,
    instrumentalUrl,
    mixed: mastered.mixed,
    matched: mastered.matched,
  };
}
