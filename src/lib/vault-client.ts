import { supabase } from "@/integrations/supabase/client";

export const VAULT_API_URL = "/api/studio/vault";
export const VAULT_NEW_GENERATION_EVENT = "hybrid:vault-new-generation";
export const VAULT_POLL_MS = 5_000;

export type VaultTrackPayload = {
  id: string;
  title: string;
  style: string;
  status: "processing" | "completed" | "failed";
  master_url?: string | null;
  instrumental_url?: string | null;
  vocal_url?: string | null;
  created_at: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function vaultAuthHeaders(): Promise<Headers> {
  const headers = new Headers({ Accept: "application/json" });
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

/** GET /api/studio/vault/tracks — signed-in artist's catalog. */
export async function fetchVaultTracks(): Promise<VaultTrackPayload[]> {
  const response = await fetch(`${VAULT_API_URL}/tracks`, {
    headers: await vaultAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Sign in to load your vault." : "Failed to load vault items");
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("Failed to load vault items");
  return body as VaultTrackPayload[];
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
}) {
  if (typeof window === "undefined") return;
  const track: VaultTrackPayload = {
    id: tempTrackData.id || `temp-${Date.now()}`,
    title: tempTrackData.title || "New Generation",
    style: tempTrackData.style || "Custom",
    status: "processing",
    created_at: new Date().toISOString(),
  };
  window.dispatchEvent(new CustomEvent(VAULT_NEW_GENERATION_EVENT, { detail: track }));
}
