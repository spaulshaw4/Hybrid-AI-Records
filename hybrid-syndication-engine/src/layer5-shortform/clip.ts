import { TrackPayload } from "../types";

export interface ShortformClipRequest {
  trackId: string;
  title: string;
  artist: string;
  previewAudioUrl: string;
  durationSeconds: number;
  aspect: "9:16";
  visualizer: "waveform";
  branding: "usa-lockup";
  destinationUrl: string;
}

export function clipDurationSeconds(trackDurationSeconds: number): number {
  if (trackDurationSeconds > 30) {
    return 30;
  }
  if (trackDurationSeconds < 15) {
    return 15;
  }
  return trackDurationSeconds;
}

export function buildShortformClipRequest(
  track: TrackPayload,
  destinationUrl: string,
): ShortformClipRequest {
  return {
    trackId: track.id,
    title: track.title,
    artist: track.artistName,
    previewAudioUrl: track.previewAudioUrl,
    durationSeconds: clipDurationSeconds(track.durationSeconds),
    aspect: "9:16",
    visualizer: "waveform",
    branding: "usa-lockup",
    destinationUrl,
  };
}
