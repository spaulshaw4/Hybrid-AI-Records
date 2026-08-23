/**
 * Voice sample length rules + trimming.
 *
 * MiniMax clones best from a clean, consistent clip, so every sample we upload
 * is normalised to exactly TARGET_SECONDS of 16-bit mono WAV. Clips that are
 * shorter than the target (nothing to trim from) or far longer than it
 * (probably a whole song, not a voice sample) are rejected before cloning.
 */

export const TARGET_SECONDS = 10;
/** A hair under the target so a 9.9s recording still counts as a full take. */
export const MIN_SECONDS = 9.5;
export const MAX_SECONDS = 60;
const SAMPLE_RATE = 44100;

export type TrimResult =
  | { ok: true; file: File; duration: number; start: number; trimmed: boolean }
  | { ok: false; message: string };

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Decodes the clip, enforces the length rules, and returns a WAV file that is
 * exactly TARGET_SECONDS long (mono, 44.1 kHz), starting at `startSeconds`.
 */
export const MIN_CLIP_SECONDS = 5;
export const MAX_CLIP_SECONDS = 60;

export async function trimVoiceSample(
  file: File,
  startSeconds = 0,
  lengthSeconds = TARGET_SECONDS,
): Promise<TrimResult> {
  const target = Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, lengthSeconds));
  const AudioCtx =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return { ok: false, message: "This browser can't process audio — try Chrome or Safari." };
  }

  const context = new AudioCtx();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const duration = decoded.duration;

    const minRequired = Math.min(MIN_SECONDS, target - 0.1);
    if (duration < minRequired) {
      return {
        ok: false,
        message: `That clip is only ${duration.toFixed(1)}s. Record or upload at least ${Math.ceil(target)} seconds of clean voice.`,
      };
    }
    if (duration > MAX_SECONDS) {
      return {
        ok: false,
        message: `That clip is ${Math.round(duration)}s long. Use a voice sample under ${MAX_SECONDS} seconds.`,
      };
    }

    // Downmix to mono and resample to 44.1 kHz, keeping the selected clipLength.
    const clipLength = Math.min(target, duration);
    const start = Math.min(Math.max(0, startSeconds), Math.max(0, duration - clipLength));
    const frames = Math.round(clipLength * SAMPLE_RATE);
    const ratio = decoded.sampleRate / SAMPLE_RATE;
    const startFrame = Math.round(start * decoded.sampleRate);
    const output = new Float32Array(frames);
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c));

    for (let i = 0; i < frames; i += 1) {
      const source = Math.min(decoded.length - 1, startFrame + Math.round(i * ratio));
      let sum = 0;
      for (const channel of channels) sum += channel[source] ?? 0;
      output[i] = sum / (channels.length || 1);
    }

    const blob = encodeWav(output, SAMPLE_RATE);
    const base = file.name.replace(/\.[^.]+$/, "") || "voice-sample";
    return {
      ok: true,
      duration,
      start,
      trimmed: duration > clipLength + 0.05,
      file: new File([blob], `${base}-${Math.round(clipLength)}s.wav`, { type: "audio/wav" }),
    };
  } catch {

    return { ok: false, message: "That audio couldn't be read. Try an .mp3 or .wav clip." };
  } finally {
    void context.close();
  }
}
