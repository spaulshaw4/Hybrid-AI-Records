import { TrackPayload } from "../types";
import { portalBaseUrl } from "../urls";

export const RADIO_DIRECTORIES = [
  "TuneIn",
  "Radio-Directory",
  "Internet-Radio",
  "Icecast",
] as const;

export interface RadioDirectoryDescriptor {
  stationName: "Hybrid AI Records";
  website: string;
  feedUrl: string;
  streamUrl?: string;
  genre: string;
  directories: typeof RADIO_DIRECTORIES;
}

export function buildRadioDirectoryDescriptor(track: TrackPayload): RadioDirectoryDescriptor {
  const website = portalBaseUrl();
  const streamUrl = process.env.RADIO_STREAM_URL?.trim();
  return {
    stationName: "Hybrid AI Records",
    website,
    feedUrl: `${website}/api/feed/mrss.xml`,
    ...(streamUrl ? { streamUrl } : {}),
    genre: track.genre,
    directories: RADIO_DIRECTORIES,
  };
}
