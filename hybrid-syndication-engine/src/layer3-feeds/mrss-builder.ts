import { TrackPayload } from "../types";

export function buildMRSSFeed(tracks: TrackPayload[]): string {
  const portalUrl = process.env.PORTAL_BASE_URL || "https://hybrid-ai-records.com";
  const buildDate = new Date().toUTCString();

  const itemsXml = tracks.map((track) => {
    const trackPage = `${portalUrl}/portal?tab=catalog&track=${encodeURIComponent(track.id)}`;
    
    return `
    <item>
      <title><![CDATA[${track.title} - ${track.artistName}]]></title>
      <link>${trackPage}</link>
      <guid isPermaLink="true">${trackPage}</guid>
      <pubDate>${new Date(track.releaseDate).toUTCString()}</pubDate>
      <description><![CDATA[Stream "${track.title}" from "${track.albumName}". Uncompressed 24-bit master audio available.]]></description>
      
      <!-- Audio Streaming Enclosure -->
      <enclosure url="${track.previewAudioUrl}" length="0" type="audio/mpeg" />
      
      <!-- Media RSS Metadata for Crawlers -->
      <media:content url="${track.previewAudioUrl}" type="audio/mpeg" medium="audio" duration="${track.durationSeconds}">
        <media:title type="plain">${track.title}</media:title>
        <media:credit role="artist">${track.artistName}</media:credit>
        <media:category>${track.genre}</media:category>
        <media:thumbnail url="${track.coverArtUrl}" width="512" height="512" />
      </media:content>
    </item>`.trim();
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Hybrid AI Records - Global Catalog Feed</title>
    <link>${portalUrl}</link>
    <description>Live broadcast catalog and mastered release distribution pipeline.</description>
    <language>en-us</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <atom:link href="${portalUrl}/api/feed/mrss.xml" rel="self" type="application/rss+xml" />
    <image>
      <url>${portalUrl}/brand/lockup-usa-512.png</url>
      <title>Hybrid AI Records</title>
      <link>${portalUrl}</link>
    </image>
${itemsXml}
  </channel>
</rss>`.trim();
}
