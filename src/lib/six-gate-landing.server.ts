/**
 * 6-gate landing responses + zero-residue cleanup for local orchestrator runs.
 */

import { rm } from "node:fs/promises";

export type MarkersUsed = "cwalo" | "fallback";

export type SixGateLandingSuccess = {
  status: "success";
  masterUrl: string;
  trackId: string;
  markersUsed: MarkersUsed;
};

export type SixGateLandingFallback = {
  status: "completed_fallback";
  masterUrl: string;
  fallbackReason: string;
  trackId: string;
  markersUsed: MarkersUsed;
};

export type SixGateLandingAbort = {
  status: "error";
  failedGate: 1 | 2 | 3 | 4 | 5 | 6;
  message: string;
};

export type SixGateLanding =
  | SixGateLandingSuccess
  | SixGateLandingFallback
  | SixGateLandingAbort;

export type SixGateFlightState = {
  useFallbackStructure: boolean;
  useDemucsVocalFallback: boolean;
  fallbackReasons: string[];
  markersUsed: MarkersUsed;
};

export function createFlightState(): SixGateFlightState {
  return {
    useFallbackStructure: false,
    useDemucsVocalFallback: false,
    fallbackReasons: [],
    markersUsed: "cwalo",
  };
}

/** Map an error message onto the fatal gate that aborted the run. */
export function classifyFailedGate(error: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const gateMatch = message.match(/Gate\s*([1-6])(?:\/6)?/i);
  if (gateMatch) {
    const n = Number(gateMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6;
    if (n >= 1 && n <= 6) return n;
  }
  if (/AIMusicAPI|empty audio buffer|Gate 1/i.test(message)) return 1;
  if (/Supabase|vault|Gate 2|public HTTPS CDN/i.test(message)) return 2;
  if (/CWALO|Gate 3/i.test(message)) return 3;
  if (/Demucs|stem|Gate 4/i.test(message)) return 4;
  if (/Fish|vocal conversion|Gate 5/i.test(message)) return 5;
  return 6;
}

export function buildSuccessLanding(input: {
  masterUrl: string;
  trackId: string;
  markersUsed: MarkersUsed;
}): SixGateLandingSuccess {
  return {
    status: "success",
    masterUrl: input.masterUrl,
    trackId: input.trackId,
    markersUsed: input.markersUsed,
  };
}

export function buildFallbackLanding(input: {
  masterUrl: string;
  trackId: string;
  fallbackReason: string;
  markersUsed: MarkersUsed;
}): SixGateLandingFallback {
  return {
    status: "completed_fallback",
    masterUrl: input.masterUrl,
    fallbackReason: input.fallbackReason,
    trackId: input.trackId,
    markersUsed: input.markersUsed,
  };
}

export function buildAbortLanding(error: unknown): SixGateLandingAbort {
  const failedGate = classifyFailedGate(error);
  const message = error instanceof Error ? error.message : String(error ?? "Unknown pipeline error");
  return {
    status: "error",
    failedGate,
    message,
  };
}

/**
 * Tracks temp dirs / files created during a run so `finally` can wipe residue.
 * Uses setTimeout-free async deletes only — never blocks the event loop.
 */
export class ResidueCleanup {
  private paths = new Set<string>();
  private buffers: Array<{ clear: () => void }> = [];

  trackPath(path: string | null | undefined): void {
    if (path?.trim()) this.paths.add(path.trim());
  }

  /** Register an in-memory buffer so it can be zeroed after the run. */
  trackBuffer(bytes: Uint8Array | null | undefined): void {
    if (!bytes) return;
    this.buffers.push({
      clear: () => {
        bytes.fill(0);
      },
    });
  }

  async dispose(): Promise<void> {
    for (const clearable of this.buffers) {
      try {
        clearable.clear();
      } catch {
        /* ignore */
      }
    }
    this.buffers = [];

    const deletes = [...this.paths].map((path) =>
      rm(path, { recursive: true, force: true }).catch(() => undefined),
    );
    this.paths.clear();
    await Promise.all(deletes);
    console.log("[Landing] Zero-residue cleanup complete");
  }
}

export function landingHttpStatus(landing: SixGateLanding): number {
  return landing.status === "error" ? 500 : 200;
}
