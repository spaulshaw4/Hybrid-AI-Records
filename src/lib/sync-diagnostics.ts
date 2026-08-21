/**
 * Post-render sync accuracy diagnostic.
 *
 * The render stage produces silent blocks whose lengths were planned against
 * the song's cut points; the master audio is muxed on at 0:00. This module
 * compares what was actually rendered against the audio timing map and reports
 * where the picture drifts away from the music, so a finished film can be
 * reviewed without scrubbing it by ear.
 *
 * Pure functions only — safe on the server and in tests.
 */

import type { AudioTimingMap } from "@/lib/audio-timing";

export type SyncBlock = {
  index: number;
  title: string;
  /** Planned block length in seconds. */
  seconds: number;
  /** True when this block went through the lip-sync stage. */
  lipSynced?: boolean;
  /** True when the planner marked this shot as a visible vocal performance. */
  vocalSync?: boolean;
};

export type BoundaryReading = {
  blockIndex: number;
  title: string;
  /** Where this block ends on the rendered timeline. */
  cutAtSeconds: number;
  /** Nearest musical cut point in the audio timing map. */
  nearestBeatSeconds: number | null;
  /** Signed distance to that cut point; positive means the picture cuts late. */
  driftSeconds: number;
};

export type SyncGrade = "locked" | "tight" | "drifting" | "out-of-sync";

export type SyncDiagnosticReport = {
  grade: SyncGrade;
  /** Total rendered runtime in seconds. */
  pictureSeconds: number;
  /** Master track length, when a timing map was produced. */
  audioSeconds: number | null;
  /** Picture length ÷ audio length. 1 means the film covers the whole song. */
  coverage: number | null;
  /** Seconds of song with no picture over it (negative = picture overruns). */
  tailGapSeconds: number | null;
  averageDriftSeconds: number;
  worstDriftSeconds: number;
  boundaries: BoundaryReading[];
  vocal: {
    /** Blocks the planner tagged as a visible vocal performance. */
    vocalBlocks: number;
    /** How many of those actually completed the lip-sync stage. */
    syncedBlocks: number;
    coverage: number;
  };
  notes: string[];
  generatedAt: string;
};

function nearest(values: number[], target: number): number | null {
  if (!values.length) return null;
  let best = values[0]!;
  for (const value of values) {
    if (Math.abs(value - target) < Math.abs(best - target)) best = value;
  }
  return best;
}

function gradeFor(worst: number, average: number, coverage: number | null): SyncGrade {
  if (coverage !== null && (coverage < 0.9 || coverage > 1.1)) return "out-of-sync";
  if (worst <= 0.12 && average <= 0.06) return "locked";
  if (worst <= 0.35 && average <= 0.18) return "tight";
  if (worst <= 0.9) return "drifting";
  return "out-of-sync";
}

/**
 * Builds the sync report. `timing` may be null (no track analysed) — the
 * report then covers runtime and lip-sync coverage only.
 */
export function buildSyncReport(input: {
  blocks: SyncBlock[];
  timing: AudioTimingMap | null;
  /** Block indexes that came back from the lip-sync stage. */
  lipSyncedIndexes?: number[];
}): SyncDiagnosticReport {
  const synced = new Set(input.lipSyncedIndexes ?? []);
  const blocks = [...input.blocks].sort((a, b) => a.index - b.index);
  const cuts = input.timing?.cuts ?? [];

  const boundaries: BoundaryReading[] = [];
  let elapsed = 0;
  for (const block of blocks) {
    elapsed += block.seconds;
    const beat = nearest(cuts, elapsed);
    boundaries.push({
      blockIndex: block.index,
      title: block.title,
      cutAtSeconds: Number(elapsed.toFixed(3)),
      nearestBeatSeconds: beat === null ? null : Number(beat.toFixed(3)),
      driftSeconds: beat === null ? 0 : Number((elapsed - beat).toFixed(3)),
    });
  }

  const drifts = boundaries
    .filter((b) => b.nearestBeatSeconds !== null)
    .map((b) => Math.abs(b.driftSeconds));
  const worst = drifts.length ? Math.max(...drifts) : 0;
  const average = drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : 0;

  const pictureSeconds = Number(elapsed.toFixed(3));
  const audioSeconds = input.timing ? Number(input.timing.durationSeconds.toFixed(3)) : null;
  const coverage = audioSeconds ? Number((pictureSeconds / audioSeconds).toFixed(4)) : null;
  const tailGapSeconds =
    audioSeconds === null ? null : Number((audioSeconds - pictureSeconds).toFixed(3));

  const vocalBlocks = blocks.filter((b) => b.vocalSync).length;
  const syncedBlocks = blocks.filter(
    (b) => b.vocalSync && (b.lipSynced || synced.has(b.index)),
  ).length;

  const notes: string[] = [];
  if (!input.timing) {
    notes.push("No audio timing map — cut points weren't measured against the song.");
  }
  if (tailGapSeconds !== null && tailGapSeconds > 1.5) {
    notes.push(
      `The picture ends ${tailGapSeconds.toFixed(1)}s before the song does — the mux trims the tail.`,
    );
  }
  if (tailGapSeconds !== null && tailGapSeconds < -1.5) {
    notes.push(
      `The picture runs ${Math.abs(tailGapSeconds).toFixed(1)}s past the song — the last block plays silent.`,
    );
  }
  if (vocalBlocks > 0 && syncedBlocks < vocalBlocks) {
    notes.push(
      `${vocalBlocks - syncedBlocks} of ${vocalBlocks} vocal shots skipped lip-sync — mouths won't track the lead.`,
    );
  }
  if (worst > 0.35) {
    notes.push(
      `Worst boundary drift is ${worst.toFixed(2)}s — re-render that block or nudge its length to the nearest cut point.`,
    );
  }
  if (!notes.length) notes.push("Every block boundary lands on a detected musical cut point.");

  return {
    grade: gradeFor(worst, average, coverage),
    pictureSeconds,
    audioSeconds,
    coverage,
    tailGapSeconds,
    averageDriftSeconds: Number(average.toFixed(3)),
    worstDriftSeconds: Number(worst.toFixed(3)),
    boundaries,
    vocal: {
      vocalBlocks,
      syncedBlocks,
      coverage: vocalBlocks ? Number((syncedBlocks / vocalBlocks).toFixed(2)) : 1,
    },
    notes,
    generatedAt: new Date().toISOString(),
  };
}

export const SYNC_GRADE_LABEL: Record<SyncGrade, string> = {
  locked: "Locked to the beat",
  tight: "Tight",
  drifting: "Drifting",
  "out-of-sync": "Out of sync",
};
