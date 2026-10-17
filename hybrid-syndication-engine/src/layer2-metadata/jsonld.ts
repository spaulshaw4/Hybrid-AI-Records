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

export function generateAlbumJsonLd(track: TrackPayload, albumUrl: string, trackUrl: string) {
  return {
    "@context": "https://schema.org",
    "@type": "MusicAlbum",
    "name": track.albumName,
    "url": albumUrl,
    "byArtist": {
      "@type": "MusicGroup",
      "name": track.artistName,
    },
    "track": {
      "@type": "MusicRecording",
      "name": track.title,
      "url": trackUrl,
    },
  };
}

export function generateLyricsJsonLd(track: TrackPayload, lyricsUrl: string) {
  const lyricText = track.lyrics?.trim();
  return {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    "name": track.title,
    "url": lyricsUrl,
    "byArtist": {
      "@type": "MusicGroup",
      "name": track.artistName,
    },
    ...(lyricText
      ? {
          lyrics: {
            "@type": "CreativeWork",
            "text": lyricText,
          },
        }
      : {}),
  };
}

export function generateStemsJsonLd(track: TrackPayload, stemsUrl: string) {
  const stems = (track.stemUrls ?? []).filter((stem) => stem.name.trim() && stem.url.trim());
  return {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    "name": track.title,
    "url": stemsUrl,
    "byArtist": {
      "@type": "MusicGroup",
      "name": track.artistName,
    },
    ...(stems.length > 0
      ? {
          hasPart: stems.map((stem) => ({
            "@type": "AudioObject",
            "name": stem.name,
            "contentUrl": stem.url,
          })),
        }
      : {}),
  };
}
