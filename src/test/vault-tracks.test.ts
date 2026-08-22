import { describe, expect, it } from "vitest";
import {
  asVaultTrackStatus,
  isPlayableVaultAudioUrl,
  sanitizeVaultTracks,
} from "@/lib/vault-tracks";

describe("sanitizeVaultTracks", () => {
  it("returns an empty list for non-arrays and corrupt rows", () => {
    expect(sanitizeVaultTracks(null)).toEqual([]);
    expect(sanitizeVaultTracks({ status: "error" })).toEqual([]);
    expect(sanitizeVaultTracks([{ title: "no id" }])).toEqual([]);
  });

  it("promotes a processing row with a playable master to completed", () => {
    const [row] = sanitizeVaultTracks([
      {
        id: "temp-1",
        title: "In flight",
        status: "processing",
        master_url: "https://cdn.example/master.mp3",
        created_at: "2026-08-22T00:00:00.000Z",
      },
    ]);
    expect(row?.status).toBe("completed");
    expect(row?.master_url).toBe("https://cdn.example/master.mp3");
  });

  it("treats completed rows with a null audio_url as failed, not playable", () => {
    const [row] = sanitizeVaultTracks([
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Broken master",
        status: "completed",
        master_url: null,
        created_at: "2026-08-22T00:00:00.000Z",
      },
    ]);
    expect(row?.status).toBe("failed");
    expect(row?.master_url).toBeNull();
  });

  it("keeps a completed master with a real https URL", () => {
    const [row] = sanitizeVaultTracks([
      {
        id: "track-1",
        title: "Ready",
        status: "completed",
        master_url: "https://cdn.example/master.mp3",
        created_at: "2026-08-22T00:00:00.000Z",
      },
    ]);
    expect(row?.status).toBe("completed");
    expect(row?.master_url).toBe("https://cdn.example/master.mp3");
  });

  it("treats same-origin local vault paths as playable completed masters", () => {
    const [row] = sanitizeVaultTracks([
      {
        id: "local-1",
        title: "Local master",
        status: "processing",
        master_url: "/api/local-vault/masters/track_master.mp3",
        created_at: "2026-08-22T00:00:00.000Z",
      },
    ]);
    expect(row?.status).toBe("completed");
    expect(row?.master_url).toBe("/api/local-vault/masters/track_master.mp3");
  });
});

describe("isPlayableVaultAudioUrl", () => {
  it("rejects empty, nullish, and non-audio strings", () => {
    expect(isPlayableVaultAudioUrl("")).toBe(false);
    expect(isPlayableVaultAudioUrl("null")).toBe(false);
    expect(isPlayableVaultAudioUrl("not-a-url")).toBe(false);
    expect(asVaultTrackStatus("bogus")).toBe("processing");
  });

  it("accepts https, blob, data, and relative vault paths", () => {
    expect(isPlayableVaultAudioUrl("https://cdn.example/a.mp3")).toBe(true);
    expect(isPlayableVaultAudioUrl("blob:https://localhost/1")).toBe(true);
    expect(isPlayableVaultAudioUrl("data:audio/mpeg;base64,AAA")).toBe(true);
    expect(isPlayableVaultAudioUrl("/api/local-vault/x.mp3")).toBe(true);
    expect(isPlayableVaultAudioUrl("/temp_masters/x.mp3")).toBe(true);
  });
});
