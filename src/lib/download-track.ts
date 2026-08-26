import { toast } from "sonner";

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
};

/** Same-origin streaming/download URL when a remote audio host blocks direct fetches. */
export function proxiedAudioDownloadUrl(url: string, downloadName?: string): string {
  const base = `/api/public/audio-proxy?url=${encodeURIComponent(url)}`;
  return downloadName ? `${base}&download=${encodeURIComponent(downloadName)}` : base;
}

/** Sanitize a download filename for Content-Disposition / the `download` attribute. */
export function sanitizeDownloadFileName(filename?: string | null, fallback = "hybrid-track.mp3"): string {
  const raw = (filename ?? "").trim() || fallback;
  return raw.replace(/[^\w.\- ()[\]]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

function extensionOf(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_MIME_BY_EXT[ext] ? ext : "mp3";
}

function mimeForFileName(filename: string): string {
  return AUDIO_MIME_BY_EXT[extensionOf(filename)] ?? "audio/mpeg";
}

/** Prefer a real audio MIME so iOS Safari treats the blob as a saveable track. */
function ensureAudioBlob(blob: Blob, filename: string): Blob {
  const mime = mimeForFileName(filename);
  if (blob.type.startsWith("audio/")) return blob;
  return new Blob([blob], { type: mime });
}

function triggerAnchorDownload(href: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.rel = "noopener";
  // iOS Safari is more reliable when the node is in the document briefly.
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Reliable track download for desktop + iOS Safari.
 *
 * Fetches the audio as a Blob, creates an object URL, and programmatically
 * clicks a download anchor (the path that actually lands in Files / Downloads
 * on iOS). Falls back to opening the direct URL if the blob fetch fails.
 */
export async function downloadTrack(url: string, filename?: string | null): Promise<void> {
  const name = sanitizeDownloadFileName(filename);
  const toastId = toast.loading("Downloading track...");

  try {
    const response = await fetch(url, {
      credentials: "include",
      mode: "cors",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Download failed (${response.status})`);
    }

    const blob = await response.blob();
    if (blob.size < 256 || /^(text\/|application\/json)/i.test(blob.type)) {
      throw new Error("Download returned an empty or invalid file");
    }

    const typedBlob = ensureAudioBlob(blob, name);
    const blobUrl = window.URL.createObjectURL(typedBlob);
    try {
      triggerAnchorDownload(blobUrl, name);
      toast.success("Saved to Downloads", {
        id: toastId,
        description: name,
      });
    } finally {
      // Keep the object URL alive long enough for Safari to start the save.
      window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 60_000);
    }
  } catch {
    toast.message("Opening download…", {
      id: toastId,
      description: "If nothing starts, long-press the audio and choose Save to Files.",
    });
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
