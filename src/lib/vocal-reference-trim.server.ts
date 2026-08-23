/**
 * Trims a Demucs vocal stem down to a short reference clip for instant voice
 * cloning.
 *
 * Fish Audio clones best from a clean 10–30s sample. Posting a whole five
 * minute stem (10 MB+) as inline MessagePack reference audio gets dropped by
 * their edge with a Cloudflare 502 before it ever reaches synthesis, so cut the
 * stem before it goes out. Trimming is best-effort: if FFmpeg is unavailable the
 * original bytes are returned and the request is left to the caller.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Upper bound of Fish Audio's recommended 10–30s reference window. */
export const REFERENCE_CLIP_SECONDS = 30;
/** Above this, inline reference audio risks a gateway drop. */
export const REFERENCE_MAX_BYTES = 2 * 1024 * 1024;

export function needsReferenceTrim(bytes: Uint8Array): boolean {
  return bytes.byteLength > REFERENCE_MAX_BYTES;
}

export async function trimVocalReference(
  bytes: Uint8Array,
  seconds = REFERENCE_CLIP_SECONDS,
): Promise<Uint8Array> {
  if (!needsReferenceTrim(bytes)) return bytes;

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "vocal-ref-"));
    const input = join(dir, "stem.mp3");
    const output = join(dir, "reference.mp3");
    await writeFile(input, bytes);
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", input, "-t", String(seconds), "-ac", "1", "-ar", "44100", output],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    const trimmed = new Uint8Array(await readFile(output));
    console.log("[GATE_4_REFERENCE_TRIM]", {
      fromBytes: bytes.byteLength,
      toBytes: trimmed.byteLength,
      seconds,
    });
    return trimmed.byteLength > 256 ? trimmed : bytes;
  } catch (error) {
    console.warn(
      "[GATE_4_REFERENCE_TRIM] trim skipped — sending the untrimmed stem",
      error instanceof Error ? error.message : error,
    );
    return bytes;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
