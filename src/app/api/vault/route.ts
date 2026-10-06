import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type VaultRow = {
  id?: string | null;
  task_id?: string | null;
  title?: string | null;
  prompt?: string | null;
  wav_url?: string | null;
  mp3_url?: string | null;
};

function vaultClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    "";
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * GET /api/vault
 * Newest 20 rows from vaulted_tracks. Client is created here so importing
 * this module does not throw when Supabase env is missing.
 */
export async function GET(): Promise<Response> {
  try {
    return await readVault();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Supabase query failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

async function readVault(): Promise<Response> {
  const supabase = vaultClient();
  if (!supabase) {
    return Response.json({ error: "Supabase is not configured" }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("vaulted_tracks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const tracks = ((data ?? []) as VaultRow[]).map((row) => ({
    id: row.id || row.task_id,
    title: row.title || "Untitled Master",
    genre: String(row.prompt || "").slice(0, 24),
    duration: "210s",
    status: "Ready",
    wav_url: row.wav_url,
    mp3_url: row.mp3_url,
  }));

  return Response.json({ tracks });
}
