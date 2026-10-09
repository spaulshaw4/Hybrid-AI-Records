import { randomUUID } from "node:crypto";

import { getTooLostClient } from "@/lib/too-lost/get-client";
import { uploadDirectToS3 } from "@/lib/too-lost/upload";
import type { TrackWrite } from "@/lib/too-lost/types";

const STORES = ["Spotify", "Apple Music", "Amazon Music", "YouTube Music", "Tidal", "Deezer"];

export type ReleaseAudio = {
  title: string;
  artist: string;
  fileName: string;
  bytes: Uint8Array;
  explicit?: boolean;
  instrumental?: boolean;
  language?: string;
};

export type DispatchedRelease = {
  releaseId: number;
  status: string;
};

function writersFor(artist: string, instrumental: boolean): TrackWrite["writers"] {
  if (instrumental) return [{ name: artist, role: ["instrumentalist"] }];
  return [
    { name: artist, role: ["instrumentalist"] },
    { name: artist, role: ["lyricist"] },
  ];
}

/**
 * Creates the Too Lost draft, uploads the WAV, writes track metadata, then submits.
 * Callers charge a D-Token only after this resolves.
 */
export async function dispatchReleaseToTooLost(input: ReleaseAudio): Promise<DispatchedRelease> {
  const title = input.title.trim();
  const artist = input.artist.trim();
  const language = (input.language || "en").trim() || "en";
  const instrumental = input.instrumental === true;
  const client = await getTooLostClient();
  const created = await client.createDraftRelease({
    title,
    type: "Single",
    participants: [{ name: artist, role: ["primary"] }],
  });
  const releaseId = created.data.id;
  const upload = await client.getTrackUploadUrl(releaseId, input.fileName, "audio/wav", "audio");
  const audio = new Blob([input.bytes], { type: "audio/wav" });
  await uploadDirectToS3(upload.data.uploadUrl, audio, upload.data.headers, "audio/wav");

  const track: TrackWrite = {
    title,
    language,
    audioFileKey: upload.data.fileKey,
    tiktokStartTime: "00:30",
    ...(instrumental ? { instrumental: true } : {}),
    lyrics: { explicit: input.explicit === true },
    artists: [{ name: artist, role: ["primary"] }],
    writers: writersFor(artist, instrumental),
  };
  await client.setTracklist(releaseId, [track]);
  await client.updateDelivery(releaseId, {
    platforms: STORES,
    territories: ["worldwide"],
    additional: { youtube: true },
  });
  const submitted = await client.submitRelease(releaseId, {
    acceptTerms: true,
    confirmRights: true,
    confirmYoutubeRights: true,
    idempotencyKey: randomUUID(),
  });
  return { releaseId: submitted.data.id, status: submitted.data.status };
}
