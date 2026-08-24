import { describe, expect, it } from "vitest";
import {
  AUDIO_VAULT_BUCKET,
  AUDIO_VAULT_MAX_BYTES,
  AUDIO_VAULT_MIME_TYPES,
  resolveAudioVaultBucket,
  storageObjectFromUrl,
  masteredTrackObjectPath,
  vaultMasterObjectPath,
  vaultMimeType,
  vaultStemObjectPath,
} from "@/lib/audio-vault";

describe("audio-vault upload contract", () => {
  it("caps objects at 150 MB and allows wav/mpeg/flac MIME types", () => {
    expect(AUDIO_VAULT_BUCKET).toBe("audio-vault");
    expect(resolveAudioVaultBucket({})).toBe("audio-vault");
    expect(resolveAudioVaultBucket({ AUDIO_VAULT_BUCKET: " raw-vault " })).toBe("raw-vault");
    expect(AUDIO_VAULT_MAX_BYTES).toBe(157_286_400);
    expect(AUDIO_VAULT_MIME_TYPES).toEqual([
      "audio/wav",
      "audio/x-wav",
      "audio/mpeg",
      "audio/mp3",
      "audio/flac",
    ]);
  });

  it("stores masters at masters/{track_id}_master.{ext} with the matching Content-Type", () => {
    expect(vaultMasterObjectPath("track-1", "wav")).toBe("masters/track-1_master.wav");
    expect(vaultMasterObjectPath("track-1", "mp3")).toBe("masters/track-1_master.mp3");
    expect(vaultMimeType("wav")).toBe("audio/wav");
    expect(vaultMimeType("mp3")).toBe("audio/mpeg");
    expect(vaultMimeType("flac")).toBe("audio/flac");
  });

  it("names stem cleanup paths next to the master", () => {
    expect(vaultStemObjectPath("abc", "vocal", "mp3")).toBe("masters/abc_vocal.mp3");
    expect(vaultStemObjectPath("abc", "instrumental", "wav")).toBe("masters/abc_instrumental.wav");
  });

  it("stores Matchering masters under mastered_tracks/", () => {
    expect(masteredTrackObjectPath("user1", "job-2", "mp3")).toBe(
      "mastered_tracks/user1/job-2_master.mp3",
    );
    expect(masteredTrackObjectPath("user1", "job-2", "wav")).toBe(
      "mastered_tracks/user1/job-2_master.wav",
    );
  });

  it("reads bucket and path from signed storage URLs", () => {
    expect(
      storageObjectFromUrl(
        "https://abc.supabase.co/storage/v1/object/sign/audio-vault/masters/t1_master.wav?token=x",
      ),
    ).toEqual({ bucket: "audio-vault", path: "masters/t1_master.wav" });
    expect(
      storageObjectFromUrl(
        "https://abc.supabase.co/storage/v1/object/sign/studio-deliveries/user/file.mp3?token=x",
      ),
    ).toEqual({ bucket: "studio-deliveries", path: "user/file.mp3" });
  });
});
