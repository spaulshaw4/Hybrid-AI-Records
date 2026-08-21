/**
 * Storage layer for admin-authored translation overrides.
 *
 * Overrides let staff correct machine-translated page copy for any supported
 * language without a redeploy: the storefront seeds its translation cache with
 * these strings before it ever calls the translation service.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type TranslationOverride = {
  language: string;
  sourceText: string;
  translatedText: string;
  updatedAt: string | null;
};

type Row = {
  language: string;
  source_text: string;
  translated_text: string;
  updated_at: string | null;
};

const toOverride = (row: Row): TranslationOverride => ({
  language: row.language,
  sourceText: row.source_text,
  translatedText: row.translated_text,
  updatedAt: row.updated_at,
});

function publicClient() {
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(process.env["SUPABASE_URL"]!, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

/** Public read used by the storefront translator. Never throws. */
export async function readOverrides(language: string): Promise<TranslationOverride[]> {
  try {
    const { data, error } = await publicClient()
      .from("translation_overrides")
      .select("language, source_text, translated_text, updated_at")
      .eq("language", language)
      .order("source_text", { ascending: true });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Row[]).map(toOverride);
  } catch (err) {
    console.error("Translation override read failed:", (err as Error).message);
    return [];
  }
}

/** Admin read: every override for a language, newest edits first. */
export async function listOverrides(language: string): Promise<TranslationOverride[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("translation_overrides")
    .select("language, source_text, translated_text, updated_at")
    .eq("language", language)
    .order("updated_at", { ascending: false });
  if (error) throw new Error("Could not load the saved translations.");
  return ((data ?? []) as Row[]).map(toOverride);
}

export async function upsertOverride(
  language: string,
  sourceText: string,
  translatedText: string,
  userId: string,
): Promise<TranslationOverride> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("translation_overrides")
    .upsert(
      {
        language,
        source_text: sourceText,
        translated_text: translatedText,
        updated_by: userId,
      },
      { onConflict: "language,source_text" },
    )
    .select("language, source_text, translated_text, updated_at")
    .maybeSingle();

  if (error || !data) {
    console.error("Translation override write failed:", error?.message);
    throw new Error("Could not save that translation. Try again shortly.");
  }
  return toOverride(data as Row);
}

export async function deleteOverride(language: string, sourceText: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("translation_overrides")
    .delete()
    .eq("language", language)
    .eq("source_text", sourceText);
  if (error) throw new Error("Could not remove that translation.");
}
