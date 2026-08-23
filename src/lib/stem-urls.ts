/**
 * Demucs output helpers (browser-safe). Maps Replicate stem dicts onto the
 * backing + vocal URLs Matchering needs.
 */

export type DemucsStemUrls = {
  vocals: string | null;
  drums: string | null;
  other: string | null;
};

function httpUrl(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("http") ? value : null;
}

/**
 * Reads vocals / accompaniment URLs from a Demucs prediction output. Replicate
 * models vary: a stem dict, a dict keyed by filename, a bare URL string, or an
 * array of URLs whose names identify the stem.
 */
export function parseDemucsOutput(output: unknown): DemucsStemUrls {
  if (typeof output === "string") {
    return { vocals: httpUrl(output), drums: null, other: null };
  }
  if (Array.isArray(output)) {
    const urls = output.map(httpUrl).filter((url): url is string => !!url);
    const match = (name: string) => urls.find((url) => url.toLowerCase().includes(name)) ?? null;
    return {
      vocals: match("vocal"),
      drums: match("drum"),
      other: match("no_vocal") ?? match("accompaniment") ?? match("instrumental") ?? match("other"),
    };
  }
  if (output && typeof output === "object") {
    const map = output as Record<string, unknown>;
    return {
      vocals: httpUrl(map.vocals) ?? httpUrl(map["vocals.wav"]) ?? httpUrl(map["vocals.mp3"]),
      drums: httpUrl(map.drums) ?? httpUrl(map["drums.wav"]),
      other:
        httpUrl(map.no_vocals) ??
        httpUrl(map["no_vocals.wav"]) ??
        httpUrl(map.accompaniment) ??
        httpUrl(map.instrumental) ??
        httpUrl(map.other) ??
        httpUrl(map["other.wav"]) ??
        httpUrl(map.bass),
    };
  }
  return { vocals: null, drums: null, other: null };
}

/** Backing track for the Matchering premaster — never the isolated vocal. */
export function backingStemUrl(
  stems: DemucsStemUrls & { instrumental?: string | null },
): string | null {
  return httpUrl(stems.instrumental) ?? stems.other ?? stems.drums;
}

/** Generation is complete only after Matchering has mixed and uploaded a master. */
export function generationCompletesAfterMaster(input: {
  masterUrl?: string | null;
  mixed?: boolean;
}): boolean {
  return Boolean(input.masterUrl?.trim() && input.mixed);
}
