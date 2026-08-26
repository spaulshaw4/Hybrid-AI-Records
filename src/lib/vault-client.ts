import { supabase } from "@/integrations/supabase/client";
import { isDevAuthBypass } from "@/lib/dev-auth";
import { sanitizeVaultTracks, type SanitizedVaultTrack } from "@/lib/vault-tracks";

export const VAULT_API_URL = "/api/studio/vault";
export const VAULT_NEW_GENERATION_EVENT = "hybrid:vault-new-generation";
/** Visible-tab poll cadence while any vault row is still processing. */
export const VAULT_POLL_MS = 4_000;
/** Hard stop for processing polls — 6 minutes; UI fails only after this with no completed row. */
export const VAULT_POLL_MAX_MS = 360_000;

export type VaultTrackPayload = SanitizedVaultTrack;

export type VaultTracksFetchResult = {
  tracks: VaultTrackPayload[];
  ok: boolean;
  /** Network / 5xx / 408 / 429 — keep polling; log silently to telemetry. */
  transientFailure: boolean;
  status?: number;
  message?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function vaultAuthHeaders(): Promise<Headers> {
  const headers = new Headers({ Accept: "application/json" });
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

/** GET /api/studio/vault/tracks with ok / transientFailure metadata. Never throws. */
export async function fetchVaultTracksResult(): Promise<VaultTracksFetchResult> {
  try {
    const response = await fetch(`${VAULT_API_URL}/tracks`, {
      headers: await vaultAuthHeaders(),
    });
    if (!response.ok) {
      if (isDevAuthBypass() || response.status === 401) {
        console.warn("[vault] catalog unavailable", response.status);
        return { tracks: [], ok: false, transientFailure: false, status: response.status };
      }
      console.warn("[vault] catalog request failed", response.status);
      return {
        tracks: [],
        ok: false,
        transientFailure: isTransientHttpStatus(response.status),
        status: response.status,
        message: `Vault catalog ${response.status}`,
      };
    }
    const body: unknown = await response.json().catch(() => []);
    return { tracks: sanitizeVaultTracks(body), ok: true, transientFailure: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[vault] catalog fetch failed", message);
    return { tracks: [], ok: false, transientFailure: true, message };
  }
}

/** GET /api/studio/vault/tracks — signed-in artist's catalog. Never throws. */
export async function fetchVaultTracks(): Promise<VaultTrackPayload[]> {
  return (await fetchVaultTracksResult()).tracks;
}

/** DELETE /api/studio/vault/tracks/:id — row + storage objects. */
export async function deleteVaultTrackApi(trackId: string): Promise<void> {
  if (!UUID.test(trackId)) {
    throw new Error("That vault track id is invalid.");
  }
  const response = await fetch(`${VAULT_API_URL}/tracks/${encodeURIComponent(trackId)}`, {
    method: "DELETE",
    headers: await vaultAuthHeaders(),
  });
  if (response.status === 404) throw new Error("Track not found.");
  if (!response.ok) throw new Error("Deletion failed on server");
}

export function isPersistedVaultId(id: string): boolean {
  return UUID.test(id);
}

/**
 * Instantly prepends a Processing row in #vault-track-list.
 * Call this from the Generate handler before the render starts.
 */
export function notifyVaultOfNewGeneration(tempTrackData: {
  id?: string;
  title?: string;
  style?: string;
  status?: "processing" | "completed" | "failed";
  masterUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  rawAudioUrl?: string | null;
  artistName?: string | null;
  albumName?: string | null;
}) {
  if (typeof window === "undefined") return;
  const status = tempTrackData.status ?? "processing";
  const track: VaultTrackPayload = {
    id: tempTrackData.id || `temp-${Date.now()}`,
    title: tempTrackData.title || "New Generation",
    style: tempTrackData.style || "Custom",
    status,
    master_url: tempTrackData.masterUrl ?? null,
    instrumental_url: tempTrackData.instrumentalUrl ?? null,
    vocal_url: tempTrackData.vocalUrl ?? null,
    raw_audio_url: tempTrackData.rawAudioUrl ?? null,
    created_at: new Date().toISOString(),
    artist_name: tempTrackData.artistName?.trim() || "Unknown Artist",
    album_name: tempTrackData.albumName?.trim() || "Singles",
  };
  window.dispatchEvent(new CustomEvent(VAULT_NEW_GENERATION_EVENT, { detail: track }));
}
