/**
 * Assembly stage — FFmpeg master remux (browser, lazy-loaded).
 *
 * The render stage produces SILENT video blocks. This module concatenates them
 * without touching the video stream (`-c copy`) and then muxes the original
 * uploaded master audio file straight onto the concatenated picture, again
 * without re-encoding video (`-c:v copy`). Audio starts at exactly 0:00.
 *
 * No audio ever reaches the scripting/render stage — the song only exists here,
 * held in the ffmpeg virtual filesystem as temporary storage.
 */

import { producerMetadataTags } from "@/lib/producer-identity";

export type RemuxProgress = {
  stage: "load" | "fetch" | "concat" | "scale" | "mux";
  percent: number;
};

/**
 * Final resolution scaling target. "native" keeps the 1080p render as a pure
 * stream copy; "4k" runs the local lanczos + unsharp pass in this browser.
 */
export type MasterScale = "native" | "4k";



const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

export function canRemuxMaster(): boolean {
  return typeof window !== "undefined" && typeof WebAssembly !== "undefined";
}

function toMp4Blob(data: unknown): Blob {
  const view = data as Uint8Array;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new Blob([copy.buffer], { type: "video/mp4" });
}

function extOf(url: string, fallback: string) {
  const clean = url.split("?")[0] ?? "";
  const match = /\.([a-z0-9]{2,4})$/i.exec(clean);
  return match?.[1]?.toLowerCase() ?? fallback;
}

/**
 * Concatenates the rendered silent blocks and muxes the master audio on top.
 * Returns an MP4 blob whose video stream is bit-identical to the rendered shots.
 */
export async function remuxMaster(
  clipUrls: string[],
  audioFile: Blob | string,
  onProgress?: (progress: RemuxProgress) => void,
  scale: MasterScale = "native",
  /** Exact master runtime (audio duration). Output is hard-clamped to it. */
  masterSeconds?: number,
): Promise<{ blob: Blob; extension: string; mimeType: string }> {
  if (!clipUrls.length) throw new Error("There are no rendered blocks to assemble yet.");


  onProgress?.({ stage: "load", percent: 0 });
  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
  ]);

  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
  });
  onProgress?.({ stage: "load", percent: 100 });

  try {
    // 1. Pull every silent block into temporary storage.
    const names: string[] = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const name = `block-${String(i).padStart(3, "0")}.mp4`;
      await ffmpeg.writeFile(name, await fetchFile(clipUrls[i]!));
      names.push(name);
      onProgress?.({ stage: "fetch", percent: Math.round(((i + 1) / clipUrls.length) * 100) });
    }

    // 2. Concatenate without re-encoding.
    await ffmpeg.writeFile(
      "concat.txt",
      names.map((name) => `file '${name}'`).join("\n"),
    );
    onProgress?.({ stage: "concat", percent: 50 });
    await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "concat.txt",
      "-c",
      "copy",
      "-an",
      "silent.mp4",
    ]);
    onProgress?.({ stage: "concat", percent: 100 });

    // 2b. Final resolution scaling — LOCAL only. No cloud upscaler, no extra
    // server render loop: the 4K master is produced here in the browser with
    // the same lanczos + unsharp pass we use offline, so it costs nothing but
    // the user's own CPU. Default stays the native 1080p stream-copy.
    let pictureName = "silent.mp4";
    if (scale === "4k") {
      onProgress?.({ stage: "scale", percent: 10 });
      await ffmpeg.exec([
        "-i",
        "silent.mp4",
        "-vf",
        "scale=3840:2160:flags=lanczos,unsharp=5:5:1.0:3:3:0.0",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "slow",
        "-an",
        "scaled.mp4",
      ]);
      pictureName = "scaled.mp4";
      onProgress?.({ stage: "scale", percent: 100 });
    }



    // Output gate: an export is only complete once the master stereo track is
    // bound to the timeline. Silent exports are blocked outright.
    if (!audioFile) {
      throw new Error(
        "Silent exports are blocked — load the master audio track before assembling the film.",
      );
    }

    // 3. Mux the untouched master audio onto the picture — video stream copied.
    const sourceName =
      typeof audioFile === "string"
        ? audioFile
        : ((audioFile as File).name ?? "") || (audioFile.type.includes("wav") ? "a.wav" : "a.mp3");
    const audioName = `master.${extOf(sourceName, "mp3")}`;
    await ffmpeg.writeFile(audioName, await fetchFile(audioFile));
    onProgress?.({ stage: "mux", percent: 20 });
    // Output clamp: the master runs exactly as long as the audio track — the
    // hero angles loop under the song and the picture is cut at the last
    // sample, so there is never a trailing silent tail.
    const clamp =
      typeof masterSeconds === "number" && masterSeconds > 0
        ? masterSeconds.toFixed(3)
        : null;
    await ffmpeg.exec([
      ...(clamp ? ["-stream_loop", "-1"] : []),
      "-i",
      pictureName,
      "-i",
      audioName,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      ...(clamp ? ["-t", clamp] : ["-shortest"]),
      // Identity lock: the master always carries the real owner's credits.

      ...Object.entries(producerMetadataTags()).flatMap(([tag, value]) => [
        "-metadata",
        `${tag}=${value}`,
      ]),
      "-movflags",
      "+faststart",
      "master.mp4",
    ]);
    onProgress?.({ stage: "mux", percent: 100 });

    const data = await ffmpeg.readFile("master.mp4");
    return {
      blob: toMp4Blob(data),
      extension: "mp4",
      mimeType: "video/mp4",
    };
  } finally {
    try {
      ffmpeg.terminate();
    } catch {
      /* already gone */
    }
  }
}
