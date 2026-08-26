/**
 * Browser poll for generation status — internal endpoint only.
 * Never call MusicAPI / Apiframe from the client.
 */

import { supabase } from "@/integrations/supabase/client";

export const GENERATE_STATUS_URL = "/api/generate/status";

export type GenerateStatusResult = {
  taskId: string;
  status: string;
  tracks: Array<{
    id: string;
    title: string | null;
    audioUrl: string | null;
    imageUrl?: string | null;
    duration: number | null;
  }>;
  correlationId: string;
};

async function authHeaders(): Promise<Headers> {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

/** Client-side should ONLY hit the internal generate status endpoint. */
export const checkStatus = async (
  taskId: string,
  retries = 3,
): Promise<GenerateStatusResult> => {
  const id = taskId.trim();
  if (!id) throw new Error("Missing taskId.");

  try {
    const res = await fetch(`${GENERATE_STATUS_URL}?taskId=${encodeURIComponent(id)}`, {
      headers: await authHeaders(),
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 502) {
        // Upstream still warming up or transient proxy blip
        if (retries > 0) {
          await new Promise((r) => setTimeout(r, 3000));
          return checkStatus(id, retries - 1);
        }
      }
      throw new Error(`Status check returned ${res.status}`);
    }
    return (await res.json()) as GenerateStatusResult;
  } catch (err) {
    // Retry transient network drops instead of aborting the entire render
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 3000));
      return checkStatus(id, retries - 1);
    }
    throw err;
  }
};
