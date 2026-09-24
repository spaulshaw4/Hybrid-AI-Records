import { describe, expect, it } from "vitest";
import {
  currentBarIndex,
  defaultChordsForKey,
  formatCatalogKey,
  formatChordArrow,
  formatDurationSeconds,
  parseRelationalSnap,
  resolveCatalogDurationSec,
  resolveCatalogGenre,
  resolveCatalogKey,
  vaultMasterUrls,
  workerDownloadUrls,
  workerJobToVaultPayload,
  durationSecFromWorkerJob,
  extractSongPlanKey,
} from "@/lib/vault-catalog";

describe("vault catalog helpers", () => {
  it("formats engine key specs as G Major", () => {
    expect(formatCatalogKey("G_major")).toBe("G Major");
    expect(formatCatalogKey("e minor")).toBe("E Minor");
    expect(formatCatalogKey("F# min")).toBe("F# Minor");
  });

  it("maps pop/funk to a major catalog key when none is locked", () => {
    expect(resolveCatalogKey("Pop, Funk", "Night Drive")).toMatch(/Major$/);
    expect(resolveCatalogKey("Metal", "Chrome", "D_minor")).toBe("D Minor");
  });

  it("defaults duration to 210s and labels it", () => {
    expect(resolveCatalogDurationSec(undefined)).toBe(210);
    expect(resolveCatalogDurationSec(209.6)).toBe(210);
    expect(formatDurationSeconds(210)).toBe("210s");
    expect(resolveCatalogGenre("Funk, analog bass")).toBe("Funk");
  });

  it("maps 96-bar seek position from playback time", () => {
    expect(currentBarIndex(0, 210)).toBe(1);
    expect(currentBarIndex(17.45, 209.45)).toBe(8);
    expect(currentBarIndex(17.46, 209.45)).toBe(9);
    expect(currentBarIndex(209.45, 209.45)).toBe(96);
  });

  it("builds local worker WAV / MP3 / ZIP stream URLs", () => {
    expect(workerDownloadUrls("ht_f27624979de9")).toEqual({
      wavUrl: "/api/stream/ht_f27624979de9_master.wav",
      mp3Url: "/api/stream/ht_f27624979de9_master.mp3",
      zipUrl: "/api/stream/ht_f27624979de9_stems_bundle.zip",
    });
  });

  it("plays and downloads the stereo master WAV first", () => {
    expect(vaultMasterUrls({ id: "ht_f27624979de9" })).toEqual({
      wavUrl: "/api/stream/ht_f27624979de9_master.wav",
      streamUrl: "/api/stream/ht_f27624979de9_master.wav",
      fallbackUrl: "/api/stream/ht_f27624979de9_master.mp3",
    });
  });

  it("parses [RELATIONAL] snap readout", () => {
    expect(
      parseRelationalSnap(
        "[RELATIONAL] kick_bass_aligned=true snaps=14 median_shift_ms=16.2 pocket=tight",
      ),
    ).toEqual({
      kickBassAligned: true,
      snaps: 14,
      medianShiftMs: 16.2,
    });
  });

  it("turns a worker job into a vault catalog row", () => {
    const row = workerJobToVaultPayload({
      session_id: "ht_abc123456789",
      status: "completed",
      genre_hint: "Funk",
      created_at: "2026-09-23T00:00:00.000Z",
      song_plan: { key: "G_major", title: "Pocket Funk", chord_progression: ["G", "C", "Em"] },
      requested_bars: 96,
      requested_bpm: 110,
    });
    expect(row?.title).toBe("Pocket Funk");
    expect(row?.musical_key).toBe("G_major");
    expect(row?.duration_sec).toBe(209);
    expect(row?.master_url).toBe("/api/stream/ht_abc123456789_master.wav");
    expect(row?.zip_url).toContain("stems_bundle.zip");
    expect(formatChordArrow(defaultChordsForKey("G Major"))).toContain("→");
  });

  it("uses song_plan bars or master_duration_sec when requested_bars is null", () => {
    const vocalJob = {
      session_id: "ht_355b3dc83e00",
      status: "completed",
      genre_hint: "Country",
      requested_bars: null,
      requested_bpm: 110,
      song_plan: { title: "Mic take", key: "G", scale: "minor", total_bars: 31, bpm: 110 },
    };
    expect(durationSecFromWorkerJob(vocalJob)).toBe(68);
    const row = workerJobToVaultPayload(vocalJob);
    expect(row?.duration_sec).toBe(68);
    expect(row?.musical_key).toBe("G_minor");
    expect(extractSongPlanKey(vocalJob.song_plan)).toBe("G_minor");
    expect(
      durationSecFromWorkerJob({
        ...vocalJob,
        master_duration_sec: 67.6,
        song_plan: { total_bars: 96, bpm: 110 },
      }),
    ).toBe(68);
  });
});
