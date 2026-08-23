import { describe, expect, it } from "vitest";
import {
  CWALO_MODEL,
  parseCwaloAnalysisJson,
  remuxGainsFromStructure,
} from "@/lib/cwalo-structure.server";
import { PIPELINE_PROGRESS, PIPELINE_PROGRESS_LABELS } from "@/lib/pipeline-progress";

describe("CWALO Gate 2", () => {
  it("pins the exact Replicate model hash", () => {
    expect(CWALO_MODEL).toBe(
      "cwalo/all-in-one-music-structure-analysis:6deeba047db17da69e9826c0285cd137cd2a81af05eb44ff496b7acd69b3a383",
    );
  });

  it("parses section boundaries, bpm, and beats from analysis JSON", () => {
    const parsed = parseCwaloAnalysisJson({
      bpm: 101,
      beats: [0, 0.5, 1],
      downbeats: [0, 2],
      segments: [
        { start: 0, end: 8, label: "intro" },
        { start: 8, end: 24, label: "verse" },
        { start: 24, end: 40, label: "chorus" },
        { start: 40, end: 48, label: "outro" },
      ],
    });
    expect(parsed.bpm).toBe(101);
    expect(parsed.sections).toHaveLength(4);
    expect(parsed.sections[0]?.label).toBe("intro");
    expect(parsed.durationSeconds).toBe(48);
  });

  it("keeps instrumental bed at unity through outro / transition sections", () => {
    const gains = remuxGainsFromStructure([
      { start: 0, end: 10, label: "verse" },
      { start: 10, end: 20, label: "outro" },
    ]);
    expect(gains.instrumentalVolume).toBe(1.0);
    expect(gains.vocalVolume).toBe(1.0);
  });

  it("exposes Analyzing structure (CWALO)… on the progress stepper", () => {
    expect(PIPELINE_PROGRESS.cwalo).toBe(48);
    expect(PIPELINE_PROGRESS_LABELS.cwalo).toBe("Analyzing structure (CWALO)…");
    expect(PIPELINE_PROGRESS.sonic).toBeLessThan(PIPELINE_PROGRESS.cwalo);
    expect(PIPELINE_PROGRESS.cwalo).toBeLessThan(PIPELINE_PROGRESS.stems);
  });
});
