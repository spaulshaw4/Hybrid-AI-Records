/**
 * Client-side master stitcher.
 *
 * The edge runtime can't run ffmpeg, so the finished scene blocks are welded
 * into ONE continuous file in the browser: each clip is drawn frame-by-frame
 * onto a shared canvas while a MediaRecorder captures the canvas stream. The
 * result is a single video file covering the whole runtime — not a playlist.
 */

export type StitchProgress = {
  sceneIndex: number;
  totalScenes: number;
  percent: number;
};

export type StitchResult = {
  blob: Blob;
  mimeType: string;
  extension: string;
};

const CANDIDATE_TYPES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function canStitchMaster(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

function pickMimeType(): string {
  for (const type of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function loadClip(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    video.onloadeddata = () => resolve(video);
    video.onerror = () => reject(new Error("A scene clip couldn't be loaded for stitching."));
  });
}

/**
 * Welds every finished clip into one master file.
 * Clips play back in order onto a single canvas so the output has no seams.
 *
 * When `audioUrl` is supplied (the song the film was cut to), the track is
 * mixed straight onto the recorded stream starting at 0:00, so the master
 * file is never silent and the audio stays aligned with the picture.
 */
export async function stitchMaster(
  clipUrls: string[],
  onProgress?: (progress: StitchProgress) => void,
  audioUrl?: string | null,
): Promise<StitchResult> {
  if (!canStitchMaster()) {
    throw new Error("This browser can't build the stitched master. Try a desktop browser.");
  }
  if (!clipUrls.length) throw new Error("There are no finished scenes to stitch yet.");

  const first = await loadClip(clipUrls[0]!);
  const width = first.videoWidth || 1280;
  const height = first.videoHeight || 720;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't open a render surface for the master.");

  const stream = canvas.captureStream(30);

  // Mix the original uploaded song onto the recording, aligned to 0:00.
  let audioCtx: AudioContext | null = null;
  let audioSource: AudioBufferSourceNode | null = null;
  if (audioUrl) {
    try {
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtor) {
        audioCtx = new AudioCtor();
        await audioCtx.resume().catch(() => undefined);
        const { fetchArrayBuffer } = await import("@/lib/safe-fetch");
        const bytes = await fetchArrayBuffer(audioUrl, {}, "Master audio download");
        const buffer = await audioCtx.decodeAudioData(bytes);
        const destination = audioCtx.createMediaStreamDestination();
        audioSource = audioCtx.createBufferSource();
        audioSource.buffer = buffer;
        audioSource.connect(destination);
        for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
      }
    } catch {
      audioCtx = null;
      audioSource = null;
    }
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 8_000_000,
    ...(audioSource ? { audioBitsPerSecond: 192_000 } : {}),
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start(1000);
  // Start the song on the same tick the recorder starts so 0:00 lines up.
  audioSource?.start();


  try {
    for (let i = 0; i < clipUrls.length; i++) {
      const clip = i === 0 ? first : await loadClip(clipUrls[i]!);
      clip.currentTime = 0;
      await clip.play().catch(() => undefined);

      await new Promise<void>((resolve) => {
        let raf = 0;
        const draw = () => {
          if (clip.ended || clip.paused) {
            cancelAnimationFrame(raf);
            resolve();
            return;
          }
          ctx.drawImage(clip, 0, 0, width, height);
          const clipPercent = clip.duration ? clip.currentTime / clip.duration : 0;
          onProgress?.({
            sceneIndex: i,
            totalScenes: clipUrls.length,
            percent: Math.min(
              99,
              Math.round(((i + clipPercent) / clipUrls.length) * 100),
            ),
          });
          raf = requestAnimationFrame(draw);
        };
        clip.onended = () => {
          cancelAnimationFrame(raf);
          resolve();
        };
        raf = requestAnimationFrame(draw);
      });

      // Hold the final frame briefly so the cut lands cleanly on the next block.
      ctx.drawImage(clip, 0, 0, width, height);
      clip.pause();
      clip.removeAttribute("src");
      clip.load();
    }
  } finally {
    recorder.stop();
    try {
      audioSource?.stop();
    } catch {
      /* already stopped */
    }
    void audioCtx?.close().catch(() => undefined);
  }


  await finished;
  onProgress?.({ sceneIndex: clipUrls.length, totalScenes: clipUrls.length, percent: 100 });

  const type = recorder.mimeType || mimeType || "video/webm";
  return {
    blob: new Blob(chunks, { type }),
    mimeType: type,
    extension: type.includes("mp4") ? "mp4" : "webm",
  };
}
