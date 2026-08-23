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

/** Reads vocals / accompaniment URLs from a Demucs prediction output. */
export function parseDemucsOutput(output: unknown): DemucsStemUrls {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const map = output as Record<string, unknown>;
    return {
      vocals: httpUrl(map.vocals),
      drums: httpUrl(map.drums),
      other:
        httpUrl(map.no_vocals) ??
        httpUrl(map.accompaniment) ??
        httpUrl(map.instrumental) ??
        httpUrl(map.other) ??
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
