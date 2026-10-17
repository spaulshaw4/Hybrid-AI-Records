import { TrackPayload } from "../types";

export function generateOpenGraphTags(track: TrackPayload, canonicalUrl: string): string {
  return `
    <!-- Standard Metadata -->
    <title>${track.title} | ${track.artistName} | Hybrid AI Records</title>
    <meta name="description" content="Listen to ${track.title} by ${track.artistName} on Hybrid AI Records. Mastered in 24-bit uncompressed audio." />

    <!-- OpenGraph / Social Embeds -->
    <meta property="og:type" content="music.song" />
    <meta property="og:title" content="${track.title} - ${track.artistName}" />
    <meta property="og:description" content="Mastered 24-Bit Release from the album '${track.albumName}'. Available on Hybrid AI Records." />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:image" content="${track.coverArtUrl}" />
    <meta property="og:image:width" content="512" />
    <meta property="og:image:height" content="512" />
    
    <!-- Audio Direct Playback Tag -->
    <meta property="og:audio" content="${track.previewAudioUrl}" />
    <meta property="og:audio:type" content="audio/mpeg" />

    <!-- Twitter / X Summary Player -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${track.title} - ${track.artistName}" />
    <meta name="twitter:description" content="Stream and unlock 24-bit studio masters directly on Hybrid AI Records." />
    <meta name="twitter:image" content="${track.coverArtUrl}" />
  `.trim();
}
