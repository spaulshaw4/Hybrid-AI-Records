/** Clean fallback when a track title is temporarily empty. */
export function hybridTrackDownloadTitle(title?: string | null): string {
  return title?.trim() || "Untitled Track";
}

/** Suggested Content-Disposition filename for Hybrid AI Records downloads. */
export function hybridTrackDownloadFileName(title?: string | null): string {
  return `${hybridTrackDownloadTitle(title)} - Hybrid AI Records.mp3`;
}
