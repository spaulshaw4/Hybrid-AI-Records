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
export async function checkStatus(taskId: string): Promise<GenerateStatusResult> {
  const id = taskId.trim();
  if (!id) throw new Error("Missing taskId.");

  const res = await fetch(`${GENERATE_STATUS_URL}?taskId=${encodeURIComponent(id)}`, {
    headers: await authHeaders(),
  });

  const body = (await res.json().catch(() => null)) as
    | GenerateStatusResult
    | { error?: string }
    | null;

  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && body.error
        ? String(body.error)
        : `Status check failed (${res.status}).`;
    throw new Error(message);
  }

  return body as GenerateStatusResult;
}
