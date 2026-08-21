import { replicateBaseUrl, replicateHeaders } from "@/lib/ai-provider.server";
import { describeFetchError } from "@/lib/safe-fetch";
/**
 * MiniMax voice cloning (server-only).
 * Replicate model: minimax/voice-cloning — takes a short clean voice sample
 * and returns a reusable `voice_id` the music model can sing with.
 */


const CLONE_PATH = "/models/minimax/voice-cloning/predictions";

export type VoiceCloneJob = {
  id: string | null;
  status: string;
  voiceId: string | null;
  error: string | null;
};

function credentials() {
  return replicateHeaders("Voice cloning");
}

function readVoiceId(payload: any): string | null {
  const output = payload?.output;
  if (typeof output === "string" && output.trim()) return output.trim();
  if (typeof output?.voice_id === "string") return output.voice_id;
  if (Array.isArray(output)) {
    const hit = output.find((value: unknown) => typeof value === "string" && value.trim());
    return (hit as string) ?? null;
  }
  return null;
}

function normalize(payload: any): VoiceCloneJob {
  return {
    id: payload?.id ?? null,
    status: String(payload?.status ?? "starting"),
    voiceId: readVoiceId(payload),
    error: payload?.error ? String(payload.error) : null,
  };
}

async function readError(res: Response) {
  const body = await res.text();
  if (res.status === 402) {
    return "The voice cloning account has no credit left. Add billing to continue.";
  }
  return `Voice cloning failed [${res.status}]: ${body.slice(0, 400)}`;
}

/** Runs a voice-cloning request with an undefined-response guard and clear errors. */
async function voiceRequest(url: string, init: RequestInit): Promise<VoiceCloneJob> {
  let res: Response | undefined;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw new Error(`Voice cloning is unreachable — ${describeFetchError(error)}.`);
  }
  if (!res) throw new Error("Voice cloning is unreachable — no response from the engine.");
  if (!res.ok) throw new Error(await readError(res));
  try {
    return normalize(await res.json());
  } catch {
    throw new Error("Voice cloning returned an unreadable response.");
  }
}

export async function startMinimaxVoiceClone(sampleUrl: string): Promise<VoiceCloneJob> {
  return voiceRequest(`${replicateBaseUrl()}${CLONE_PATH}`, {
    method: "POST",
    headers: credentials(),
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ input: { voice_file: sampleUrl } }),
  });
}

export async function fetchMinimaxVoiceClone(id: string): Promise<VoiceCloneJob> {
  return voiceRequest(`${replicateBaseUrl()}/predictions/${encodeURIComponent(id)}`, {
    headers: credentials(),
    signal: AbortSignal.timeout(30_000),
  });
}
