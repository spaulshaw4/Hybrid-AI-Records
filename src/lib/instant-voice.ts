import type { VoiceCloneJob } from "@/lib/minimax-voice.server";

export function newInstantVoiceId(): string {
  return `voice_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/** Saving a take does not train a remote model — cloning happens at generate. */
export function startInstantVoiceClone(): VoiceCloneJob {
  return {
    id: null,
    status: "succeeded",
    voiceId: newInstantVoiceId(),
    error: null,
  };
}

export function samplePathFromUrl(url: string): string | null {
  const match = /\/voice-samples\/([^?]+)/i.exec(url);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
