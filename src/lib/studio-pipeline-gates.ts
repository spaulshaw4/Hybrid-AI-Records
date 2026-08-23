/**
 * Sequential execution gates for the studio generate path.
 * Pre-conditions throw FAIL_EARLY_GUARD. Post-conditions throw GATE_N_FAILED
 * so a broken payload is never handed to the next stage.
 */

import { readAudioSampleRate, uniquePositiveRates } from "@/lib/audio-sample-rate";
import {
  isHttpAudioUrl,
  logGateCleared,
  throwFailEarly,
} from "@/lib/pipeline-contracts";
import { backingStemUrl, type DemucsStemUrls } from "@/lib/stem-urls";
import { StudioPipelineError } from "@/lib/studio-pipeline-error";

export { isHttpAudioUrl };

/** Gate 1 — lyrics must be non-empty before Sonic, unless the render is instrumental. */
export function assertLyricsGate(input: {
  lyrics?: string | null;
  isInstrumental?: boolean;
}): void {
  if (input.isInstrumental) {
    logGateCleared(1, "Lyrics skipped (instrumental)");
    return;
  }
  if (!input.lyrics?.trim()) {
    throwFailEarly("music", "lyrics were empty");
  }
  logGateCleared(1, "Lyrics verified");
}

export async function probeAudioUrlReachable(url: string): Promise<boolean> {
  if (!isHttpAudioUrl(url)) return false;
  const accept = (status: number) => status >= 200 && status < 400;
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (accept(head.status)) return true;
  } catch {
    /* CDNs often reject HEAD — fall through to a ranged GET. */
  }
  try {
    const get = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
    });
    return accept(get.status) || get.status === 206;
  } catch {
    return false;
  }
}

/** Gate 2 precondition — `data[0].audio_url` must be a live HTTP URL before CWALO. */
export async function assertBaseAudioUrlGate(url: string | null | undefined): Promise<string> {
  if (!isHttpAudioUrl(url)) {
    throw new StudioPipelineError("GATE_1", "Base audio URL was not returned");
  }
  const reachable = await probeAudioUrlReachable(url);
  if (!reachable) {
    throw new StudioPipelineError("GATE_1", "Base audio URL was not returned");
  }
  logGateCleared(1, `Audio URL verified for CWALO: ${url}`);
  return url;
}

export type StemGateInput = DemucsStemUrls & { instrumental?: string | null };

/** Gate 3 — Demucs vocals + instrumental must exist before Fish or a local mix. */
export function assertDemucsStemUrlGate(
  stems: StemGateInput,
  options: { required: boolean } = { required: true },
): { vocals: string; instrumental: string } {
  const vocals = isHttpAudioUrl(stems.vocals) ? stems.vocals.trim() : null;
  const instrumental = isHttpAudioUrl(backingStemUrl(stems)) ? backingStemUrl(stems) : null;
  if (!options.required) {
    if (vocals && instrumental) {
      logGateCleared(3, `Stem URLs verified: vocals=${vocals} instrumental=${instrumental}`);
    }
    return { vocals: vocals ?? "", instrumental: instrumental ?? "" };
  }
  if (!vocals || !instrumental) {
    throw new StudioPipelineError("GATE_3", "Demucs stem URLs were missing");
  }
  logGateCleared(3, `Stem URLs verified: vocals=${vocals} instrumental=${instrumental}`);
  return { vocals, instrumental };
}

/** Gate 4 — confirmed sample rates on the buffers heading to Matchering must match. */
export function assertSampleRateGate(
  buffers: Array<{ label: string; bytes: Uint8Array }>,
): number | null {
  const rates = buffers.map((buffer) => ({
    label: buffer.label,
    rate: readAudioSampleRate(buffer.bytes),
  }));
  const unique = uniquePositiveRates(rates.map((item) => item.rate));
  if (unique.length > 1) {
    throw new StudioPipelineError(
      "GATE_4",
      `Sample rates were inconsistent (${unique.join(" vs ")} Hz)`,
    );
  }
  const rate = unique[0] ?? null;
  if (rate) {
    logGateCleared(4, `Sample rate verified: ${rate} Hz`);
  }
  return rate;
}
