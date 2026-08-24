import { describe, expect, it } from "vitest";
import {
  asVaultTrackStatus,
  groupVaultTracksByArtistAlbum,
  isPlayableVaultAudioUrl,
  sanitizeVaultTracks,
  VAULT_DEFAULT_ALBUM,
  VAULT_DEFAULT_ARTIST,
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
    expect(row?.artist_name).toBe(VAULT_DEFAULT_ARTIST);
    expect(row?.album_name).toBe(VAULT_DEFAULT_ALBUM);
  });

  it("resolves artist/album from PostgREST embeds", () => {
    const [row] = sanitizeVaultTracks([
      {
        id: "track-rel",
        title: "Joined",
        status: "completed",
        master_url: "https://cdn.example/master.mp3",
        created_at: "2026-08-22T00:00:00.000Z",
        artist: { id: "a1", name: "Hybrid AI" },
        album: { id: "b1", name: "Night Drive" },
      },
    ]);
    expect(row?.artist_name).toBe("Hybrid AI");
    expect(row?.album_name).toBe("Night Drive");
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

describe("groupVaultTracksByArtistAlbum", () => {
  it("groups artist_name → album_name", () => {
    const grouped = groupVaultTracksByArtistAlbum(
      sanitizeVaultTracks([
        {
          id: "1",
          title: "B",
          status: "completed",
          master_url: "https://cdn.example/b.mp3",
          created_at: "2026-08-22T02:00:00.000Z",
          artist_name: "Hybrid AI",
          album_name: "Night Drive",
        },
        {
          id: "2",
          title: "A",
          status: "completed",
          master_url: "https://cdn.example/a.mp3",
          created_at: "2026-08-22T03:00:00.000Z",
          artist_name: "Hybrid AI",
          album_name: "Night Drive",
        },
        {
          id: "3",
          title: "Solo",
          status: "completed",
          master_url: "https://cdn.example/c.mp3",
          created_at: "2026-08-22T01:00:00.000Z",
          artist_name: "Hybrid AI",
          album_name: "Singles",
        },
        {
          id: "4",
          title: "Other",
          status: "completed",
          master_url: "https://cdn.example/d.mp3",
          created_at: "2026-08-22T01:00:00.000Z",
          artist: { name: "Jester AI" },
          album: { name: "Campfire" },
        },
      ]),
    );

    expect(grouped.map((g) => g.artist_name)).toEqual(["Hybrid AI", "Jester AI"]);
    expect(grouped[0]?.albums.map((a) => a.album_name)).toEqual(["Night Drive", "Singles"]);
    expect(grouped[0]?.albums[0]?.tracks.map((t) => t.id)).toEqual(["2", "1"]);
    expect(grouped[1]?.albums[0]?.album_name).toBe("Campfire");
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
