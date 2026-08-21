import { AUDIO_VAULT_BUCKET, STUDIO_AUDIO_BUCKET, storageObjectFromUrl, storagePathFromUrl } from "@/lib/audio-vault";
import { archiveGeneratedAudio } from "./apiframe.server";

export { AUDIO_VAULT_BUCKET, STUDIO_AUDIO_BUCKET, storageObjectFromUrl, storagePathFromUrl };
const SIGNED_URL_TTL = 60 * 60 * 24 * 365;

/** Fresh signed URLs for objects in studio-deliveries and audio-vault. */
export async function signedUrlsForStored(
  urls: Array<string | null>,
): Promise<Map<string, string>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const grouped = new Map<string, Array<{ url: string; path: string }>>();
  for (const url of urls) {
    if (!url) continue;
    const object = storageObjectFromUrl(url);
    if (!object) continue;
    const list = grouped.get(object.bucket) ?? [];
    list.push({ url, path: object.path });
    grouped.set(object.bucket, list);
  }

  const signed = new Map<string, string>();
  for (const [bucket, items] of grouped) {
    const { data } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrls(
        [...new Set(items.map((item) => item.path))],
        SIGNED_URL_TTL,
      );
    const byPath = new Map(
      (data ?? [])
        .filter((entry): entry is { path: string; signedUrl: string; error: null } =>
          Boolean(entry.signedUrl && entry.path),
        )
        .map((entry) => [entry.path, entry.signedUrl] as const),
    );
    for (const item of items) {
      const next = byPath.get(item.path);
      if (next) signed.set(item.url, next);
    }
  }
  return signed;
}

/** True when the URL still serves playable bytes. */
async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-1" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok && res.status !== 206) return false;
    const type = res.headers.get("content-type") ?? "";
    res.body?.cancel().catch(() => undefined);
    return !/^(text\/|application\/(json|problem\+json))/i.test(type);
  } catch {
    return false;
  }
}

export type RefreshOutcome =
  | { status: "ok"; audioUrl: string; renewed: boolean }
  | { status: "expired" };

/**
 * Returns a working URL for a previously generated track.
 *
 * - Archived tracks get a freshly signed storage URL (never expires for the user).
 * - Engine CDN links that are still alive are copied into permanent storage.
 * - Links whose audio is gone report `expired` so the UI can offer a re-generate.
 */
export async function refreshTrackAudio(
  audioUrl: string,
  userId: string,
): Promise<RefreshOutcome> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const object = storageObjectFromUrl(audioUrl);
  if (object) {
    const { data, error } = await supabaseAdmin.storage
      .from(object.bucket)
      .createSignedUrl(object.path, SIGNED_URL_TTL);
    if (!error && data?.signedUrl) return { status: "ok", audioUrl: data.signedUrl, renewed: true };
    return { status: "expired" };
  }

  // Engine CDN link: archive it permanently while it is still reachable.
  if (await isReachable(audioUrl)) {
    try {
      const taskId = `rescued-${Buffer.from(audioUrl).toString("base64url").slice(-24)}`;
      const signed = await archiveGeneratedAudio(audioUrl, userId, taskId);
      return { status: "ok", audioUrl: signed, renewed: true };
    } catch {
      return { status: "ok", audioUrl, renewed: false };
    }
  }

  return { status: "expired" };
}
