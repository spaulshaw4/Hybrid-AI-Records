import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type HybridTrackStems = {
  title: string;
  genrePrompt?: string;
  lyrics?: string;
  introUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  masterUrl?: string | null;
};

/** Persists pipeline stems after a generate. Never throws — a vault miss must not fail the render. */
export async function persistHybridTrack(
  supabase: SupabaseClient<Database>,
  userId: string,
  stems: HybridTrackStems,
): Promise<string | null> {
  const masterUrl =
    stems.masterUrl || stems.vocalUrl || stems.instrumentalUrl || stems.introUrl || null;
  const { data, error } = await supabase
    .from("tracks")
    .insert({
      user_id: userId,
      title: stems.title.trim() || "Untitled master track",
      genre_prompt: stems.genrePrompt?.trim() || null,
      lyrics: stems.lyrics?.trim() || null,
      intro_url: stems.introUrl || null,
      instrumental_url: stems.instrumentalUrl || null,
      vocal_url: stems.vocalUrl || null,
      master_url: masterUrl,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    console.warn("[tracks] persist failed", error.message);
    return null;
  }
  return data?.id ?? null;
}
