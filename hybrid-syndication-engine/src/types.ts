export interface TrackPayload {
  id: string;
  isrc?: string;
  title: string;
  artistName: string;
  albumName: string;
  genre: string;
  releaseDate: string; // ISO format: YYYY-MM-DD
  durationSeconds: number;
  previewAudioUrl: string; // 30s preview MP3/WAV
  masterAudioUrl: string;  // 24-bit broadcast master
  coverArtUrl: string;    // Square 512x512 or 3000x3000
  explicit: boolean;
  tokenPriceUsd: number;
}
