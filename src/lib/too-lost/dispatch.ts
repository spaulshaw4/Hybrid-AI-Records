import { randomUUID } from "node:crypto";

import { DEFAULT_RECORD_LABEL } from "@/lib/distribution-media";
import { getTooLostClient } from "@/lib/too-lost/get-client";
import {
  ENTERPRISE_RELEASE_FLAGS,
  type AdditionalDelivery,
  type CatalogReleaseType,
  type DraftReleaseInput,
  type TrackWrite,
} from "@/lib/too-lost/types";
import { uploadDirectToS3 } from "@/lib/too-lost/upload";

export type ReleaseCover = {
  fileName: string;
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png";
};

export type ReleaseClip = {
  fileName: string;
  bytes: Uint8Array;
  audioContentType: "audio/wav" | "audio/flac";
};

export type ReleaseAudio = {
  title: string;
  artist: string;
  fileName: string;
  bytes: Uint8Array;
  audioContentType: "audio/wav" | "audio/flac";
  clips?: ReleaseClip[];
  explicit: boolean;
  instrumental?: boolean;
  language?: string;
  label: string;
  genre: string;
  cover: ReleaseCover;
  composer: string;
  lyricist: string;
  pLine: string;
  cLine: string;
  recordingType: string;
  lyrics?: string;
  artistId?: string | number | null;
  releaseDate?: string;
  /** profiles.display_name. This schema has no full_name. */
  displayName?: string;
};

export type DispatchedRelease = {
  accepted: boolean;
  releaseId: number;
  httpStatus: number;
  status: string | null;
  spotifyUri: string | null;
  upc: string | null;
};

const SPOTIFY_KEYS = ["spotifyUri", "spotify_uri", "spotifyURI", "spotifyUrl", "spotify_url"];
const UPC_KEYS = ["upc", "UPC"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cleanCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return null;
  if (/bearer|api[_-]?key|secret/i.test(text)) return null;
  return text;
}

function firstCode(source: Record<string, unknown> | null, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const code = cleanCode(source[key]);
    if (code) return code;
  }
  return null;
}

function spotifyFromList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const row = asRecord(item);
    if (!row) continue;
    const named = firstCode(row, SPOTIFY_KEYS);
    if (named) return named;
    const platform = firstCode(row, ["platform", "store", "name", "service", "dsp"]);
    const uri = firstCode(row, ["uri", "url", "code"]);
    if (platform && /spotify/i.test(platform) && uri) return uri;
    if (uri && (/^spotify:/i.test(uri) || /open\.spotify\.com/i.test(uri))) return uri;
  }
  return null;
}

/** Reads status and store codes that Too Lost actually returned. Missing codes stay null. */
export function readIngestionResult(body: unknown): {
  status: string | null;
  spotifyUri: string | null;
  upc: string | null;
} {
  const root = asRecord(body);
  const data = asRecord(root?.data);
  const nested = asRecord(data?.release) ?? asRecord(root?.release);
  const sources = [data, nested, root].filter((item): item is Record<string, unknown> => Boolean(item));
  let status: string | null = null;
  let upc: string | null = null;
  let spotifyUri: string | null = null;
  for (const source of sources) {
    if (!status) {
      const raw = cleanCode(source.status);
      if (raw && raw.length <= 40) status = raw;
    }
    if (!upc) upc = firstCode(source, UPC_KEYS) ?? firstCode(asRecord(source.codes), UPC_KEYS);
    if (!spotifyUri) {
      spotifyUri =
        firstCode(source, SPOTIFY_KEYS) ??
        spotifyFromList(source.stores) ??
        spotifyFromList(source.storeCodes) ??
        spotifyFromList(source.platforms) ??
        firstCode(asRecord(source.codes), SPOTIFY_KEYS);
    }
  }
  return { status, spotifyUri, upc };
}

function positiveId(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d{0,17}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

const BEATPORT_GENRE = /\b(house|techno|trance|drum and bass|edm|electronic|dubstep)\b/i;

/** single for 1–3 tracks, ep for 4–6, album for 7 or more. */
export function releaseTypeForTrackCount(trackCount: number): CatalogReleaseType {
  if (trackCount <= 3) return "single";
  if (trackCount <= 6) return "ep";
  return "album";
}

function catalogType(releaseType: CatalogReleaseType): DraftReleaseInput["type"] {
  if (releaseType === "ep") return "EP";
  if (releaseType === "album") return "Album";
  return "Single";
}

function clipsFrom(input: ReleaseAudio): ReleaseClip[] {
  if (input.clips && input.clips.length > 0) return input.clips;
  return [{ fileName: input.fileName, bytes: input.bytes, audioContentType: input.audioContentType }];
}

function releaseDateOrDefault(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
}

/**
 * Creates the Too Lost release, uploads cover and audio, then submits.
 * Enterprise flags are hardcoded. A D-Token is spent only when this returns accepted.
 */
export async function dispatchReleaseToTooLost(input: ReleaseAudio): Promise<DispatchedRelease> {
  const title = input.title.trim();
  const artist = input.artist.trim();
  const label = DEFAULT_RECORD_LABEL;
  const genre = input.genre.trim();
  const composer = input.composer.trim();
  const lyricist = input.lyricist.trim();
  const recordingType = input.recordingType.trim();
  const explicit = input.explicit === true;
  const instrumental = input.instrumental === true;
  const lyrics = (input.lyrics ?? "").trim();
  const creditName = (input.displayName ?? "").trim() || artist;
  const year = new Date().getFullYear();
  const cLine = `${year} ${creditName}`;
  const pLine = `${year} Hybrid AI Records`;
  const clips = clipsFrom(input);
  const releaseType = releaseTypeForTrackCount(clips.length);
  const additionalDelivery: AdditionalDelivery = {
    youtube_content_id: true,
    meta_rights_manager: true,
    soundcloud_monetization: true,
    soundexchange: true,
    tracklib: true,
    hook: true,
    roblox: true,
    managed_media: true,
    lyricfind: !instrumental && lyrics.length > 0,
    beatport: BEATPORT_GENRE.test(genre),
    udio_training: false,
  };
  const release: DraftReleaseInput = {
    title,
    type: catalogType(releaseType),
    release_type: releaseType,
    label,
    genre,
    primary_genre: genre,
    participants: [{ name: artist, role: ["primary"] }],
    primary_artist_id: input.artistId ?? null,
    primary_artist_name: artist,
    release_date: releaseDateOrDefault(input.releaseDate),
    language: "English",
    is_instrumental: instrumental,
    c_line: cLine,
    p_line: pLine,
    licensing_type: "Copyright",
    itunes_track_price: "1.29",
    itunes_album_price: "4.99",
    additional_delivery: additionalDelivery,
    ...ENTERPRISE_RELEASE_FLAGS,
  };
  const client = await getTooLostClient();
  const created = await client.createDraftRelease(release);
  const draftId = created.data.id;
  const artwork = await client.getArtworkUploadUrl(draftId, input.cover.fileName, input.cover.contentType);
  const coverBlob = new Blob(
    [new Uint8Array(input.cover.bytes.buffer as ArrayBuffer, input.cover.bytes.byteOffset, input.cover.bytes.byteLength)],
    { type: input.cover.contentType },
  );
  await uploadDirectToS3(artwork.data.uploadUrl, coverBlob, artwork.data.headers, input.cover.contentType);
  await client.updateMetadata(draftId, {
    ...release,
    coverFileKey: artwork.data.fileKey,
  });

  const tracks: TrackWrite[] = [];
  for (const [index, clip] of clips.entries()) {
    const upload = await client.getTrackUploadUrl(draftId, clip.fileName, clip.audioContentType, "audio");
    const audio = new Blob(
      [new Uint8Array(clip.bytes.buffer as ArrayBuffer, clip.bytes.byteOffset, clip.bytes.byteLength)],
      { type: clip.audioContentType },
    );
    await uploadDirectToS3(upload.data.uploadUrl, audio, upload.data.headers, clip.audioContentType);
    const trackTitle = clips.length === 1 || index === 0 ? title : `${title} ${index + 1}`;
    tracks.push({
      title: trackTitle,
      language: "English",
      audioFileKey: upload.data.fileKey,
      tiktokStartTime: "00:30",
      ...(instrumental ? { instrumental: true } : {}),
      lyrics: { explicit },
      is_explicit: explicit,
      composer,
      lyricist,
      p_line: pLine,
      c_line: cLine,
      recording_type: recordingType,
      artists: [{ name: artist, role: ["primary"] }],
      writers: [
        { name: composer, role: ["composer"] },
        { name: lyricist, role: ["lyricist"] },
      ],
    });
  }
  await client.setTracklist(draftId, tracks);
  await client.updateDelivery(draftId, {
    platforms: ["all"],
    territories: ["worldwide"],
    additional: { youtube: true },
  });
  const submitted = await client.submitRelease(draftId, {
    acceptTerms: true,
    confirmRights: true,
    confirmYoutubeRights: true,
    idempotencyKey: randomUUID(),
  });
  const httpStatus = submitted.status;
  const releaseId = positiveId(submitted.data?.id);
  const ingestion = readIngestionResult(submitted);
  return {
    accepted: (httpStatus === 200 || httpStatus === 201) && releaseId > 0,
    releaseId,
    httpStatus,
    status: ingestion.status,
    spotifyUri: ingestion.spotifyUri,
    upc: ingestion.upc,
  };
}
