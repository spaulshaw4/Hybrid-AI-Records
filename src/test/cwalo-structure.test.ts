import { describe, expect, it } from "vitest";
import {
  CWALO_MODEL,
  CWALO_TAIL_FADE_SECONDS,
  buildCwaloMasterPlan,
  buildCwaloRunInput,
  buildSectionVolumeExpression,
  classifyCwaloSection,
  parseCwaloAnalysisJson,
  remuxGainsFromStructure,
} from "@/lib/cwalo-structure.server";
import {
  isPublicHttpAudioUrl,
  preferPublicAudioUrl,
} from "@/lib/pipeline-contracts";
import { PIPELINE_PROGRESS, PIPELINE_PROGRESS_LABELS } from "@/lib/pipeline-progress";

describe("CWALO Gate 3", () => {
  it("pins the exact Replicate model hash", () => {
    expect(CWALO_MODEL).toBe(
      "cwalo/all-in-one-music-structure-analysis:6deeba047db17da69e9826c0285cd137cd2a81af05eb44ff496b7acd69b3a383",
    );
  });

  it("builds the exact CWALO container input schema", () => {
    const url = "https://cdn.example.com/raw/track.mp3";
    expect(buildCwaloRunInput(url)).toEqual({
      music_input: url,
      model: "harmonix-all",
      demux: false,
      sonify: false,
      visualize: false,
      activ: false,
      embed: false,
      include_embeddings: false,
      include_activations: false,
    });
  });

  it("parses section boundaries, energy profile, outro_start, and track_end", () => {
    const parsed = parseCwaloAnalysisJson({
      bpm: 101,
      beats: [0, 0.5, 1],
      downbeats: [0, 2],
      energy_profile: [0.2, 0.5, 0.9, 0.4],
      outro_start: 40,
      track_end: 48,
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
    expect(parsed.energyProfile).toEqual([0.2, 0.5, 0.9, 0.4]);
    expect(parsed.outroStart).toBe(40);
    expect(parsed.trackEnd).toBe(48);
  });

  it("keeps instrumental bed at unity through outro / transition sections", () => {
    const gains = remuxGainsFromStructure([
      { start: 0, end: 10, label: "verse" },
      { start: 10, end: 20, label: "outro" },
    ]);
    expect(gains.instrumentalVolume).toBe(1.0);
    expect(gains.vocalVolume).toBe(1.0);
  });

  it("builds dynamic volume envelopes for verse pockets vs chorus/outro", () => {
    expect(classifyCwaloSection("Verse 1")).toBe("verse");
    expect(classifyCwaloSection("Chorus")).toBe("chorus");
    const sections = [
      { start: 0, end: 8, label: "intro" },
      { start: 8, end: 24, label: "verse" },
      { start: 24, end: 40, label: "chorus" },
      { start: 40, end: 48, label: "outro" },
    ];
    const inst = buildSectionVolumeExpression(sections, "instrumental");
    const voc = buildSectionVolumeExpression(sections, "vocal");
    expect(inst).toContain("between(t\\,8\\,24)");
    expect(inst).toContain("0.88");
    expect(inst).toContain("1.0");
    expect(voc).toContain("1.12");
    const plan = buildCwaloMasterPlan({
      bpm: 101,
      beats: [],
      downbeats: [],
      sections,
      energyProfile: [],
      outroStart: 40,
      trackEnd: 48,
      durationSeconds: 48,
    });
    expect(plan.fadeOutSeconds).toBe(CWALO_TAIL_FADE_SECONDS);
    expect(plan.trackEnd).toBe(48);
    expect(plan.instrumentalVolumeExpr).toBeTruthy();
    expect(plan.vocalVolumeExpr).toBeTruthy();
  });

  it("exposes Analyzing structure (CWALO)… on the progress stepper", () => {
    expect(PIPELINE_PROGRESS.cwalo).toBe(48);
    expect(PIPELINE_PROGRESS_LABELS.cwalo).toBe("Analyzing structure (CWALO)…");
    expect(PIPELINE_PROGRESS.sonic).toBeLessThan(PIPELINE_PROGRESS.cwalo);
    expect(PIPELINE_PROGRESS.cwalo).toBeLessThan(PIPELINE_PROGRESS.stems);
  });

  it("rejects localhost vault URLs as public Replicate inputs", () => {
    expect(
      isPublicHttpAudioUrl(
        "http://localhost:8080/api/local-vault/11111111-1111-4111-8111-111111111111__track_mp3.mp3",
      ),
    ).toBe(false);
    expect(isPublicHttpAudioUrl("https://cdn.aimusicapi.com/clips/abc.mp3")).toBe(true);
    expect(
      preferPublicAudioUrl(
        "http://localhost:8080/api/local-vault/x.mp3",
        "https://cdn.aimusicapi.com/clips/abc.mp3",
      ),
    ).toBe("https://cdn.aimusicapi.com/clips/abc.mp3");
    expect(preferPublicAudioUrl("http://localhost:8080/api/local-vault/x.mp3")).toBeNull();
  });
});
