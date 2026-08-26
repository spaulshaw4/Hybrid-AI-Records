import { hybridTrackDownloadFileName } from "@/lib/track-download-name";

/** Catalog audio objects in Supabase Storage. */
export const TRACKS_STORAGE_BUCKET = "tracks";

const DEFAULT_SIGNED_TTL_SECONDS = 3600;

/**
 * Mints a short-lived signed URL that forces a download with the branded
 * filename (`{title} - Hybrid AI Records.mp3`).
 */
export async function createTracksBucketSignedDownloadUrl(
  filePath: string,
  trackTitle?: string | null,
  expiresIn = DEFAULT_SIGNED_TTL_SECONDS,
): Promise<string | null> {
  const path = filePath.trim();
  if (!path) return null;

  const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const supabase = requireSupabaseAdmin();
  const download = hybridTrackDownloadFileName(trackTitle);

  const { data, error } = await supabase.storage
    .from(TRACKS_STORAGE_BUCKET)
    .createSignedUrl(path, expiresIn, { download });

  if (error || !data?.signedUrl) {
    console.warn(
      "[tracks] createSignedUrl failed",
      error?.message ?? "missing signedUrl",
      { path },
    );
    return null;
  }
  return data.signedUrl;
}
