/**
 * Builds a Content-Disposition value that forces a file save with a stable
 * filename on modern browsers (incl. iOS Safari / Files).
 */
export function attachmentContentDisposition(fileName: string): string {
  const safe = fileName.replace(/[^\w.\- ()[\]]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "hybrid-track.mp3";
  // ASCII fallback for older clients; UTF-8 filename* for full Unicode titles.
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/** Pick an audio Content-Type from a filename when upstream is generic. */
export function audioContentTypeForFileName(fileName: string, upstream?: string | null): string {
  if (upstream && upstream.startsWith("audio/")) return upstream;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "wav":
      return "audio/wav";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "webm":
      return "audio/webm";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}
