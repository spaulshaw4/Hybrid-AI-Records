import { TrackPayload } from "./types";

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['\u2019\u2018\u02BC]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function portalBaseUrl(): string {
  const configured = process.env.PORTAL_BASE_URL || "https://hybrid-ai-records.com";
  return configured.replace(/\/+$/, "");
}

export interface ReleaseUrls {
  album: string;
  track: string;
  lyrics: string;
  stems: string;
}

export function buildReleaseUrls(track: Pick<TrackPayload, "title" | "albumName">): ReleaseUrls {
  const base = portalBaseUrl();
  const trackUrl = `${base}/track/${slugify(track.title)}`;
  return {
    album: `${base}/catalog/${slugify(track.albumName)}`,
    track: trackUrl,
    lyrics: `${trackUrl}/lyrics`,
    stems: `${trackUrl}/stems`,
  };
}
