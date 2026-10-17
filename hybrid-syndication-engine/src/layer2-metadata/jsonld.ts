import { TrackPayload } from "../types";

export function generateTrackJsonLd(track: TrackPayload, canonicalUrl: string) {
  // Convert duration seconds into ISO 8601 duration format (PT#M#S)
  const minutes = Math.floor(track.durationSeconds / 60);
  const seconds = track.durationSeconds % 60;
  const isoDuration = `PT${minutes}M${seconds}S`;

  return {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    "name": track.title,
    "url": canonicalUrl,
    "image": track.coverArtUrl,
    "duration": isoDuration,
    "datePublished": track.releaseDate,
    "inAlbum": {
      "@type": "MusicAlbum",
      "name": track.albumName,
      "byArtist": {
        "@type": "MusicGroup",
        "name": track.artistName,
      },
    },
    "byArtist": {
      "@type": "MusicGroup",
      "name": track.artistName,
    },
    "audio": {
      "@type": "AudioObject",
      "contentUrl": track.previewAudioUrl,
      "encodingFormat": "audio/mpeg",
      "description": "Uncompressed 24-bit broadcast preview snippet",
    },
    "offers": {
      "@type": "Offer",
      "price": track.tokenPriceUsd.toFixed(2),
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": canonicalUrl,
    },
  };
}
