import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { TranslationOverride } from "@/lib/translation-overrides.types";

const LANGUAGE = z.string().trim().min(2).max(8);
const SOURCE = z.string().trim().min(1).max(2_000);
const TRANSLATION = z.string().trim().min(1).max(4_000);

const languageSchema = z.object({ language: LANGUAGE });
const saveSchema = z.object({
  language: LANGUAGE,
  sourceText: SOURCE,
  translatedText: TRANSLATION,
});
const removeSchema = z.object({ language: LANGUAGE, sourceText: SOURCE });

/** Public read: the storefront seeds its translation cache with these. */
export const getTranslationOverrides = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => languageSchema.parse(data))
  .handler(async ({ data }): Promise<TranslationOverride[]> => {
    const { readOverrides } = await import("@/lib/translation-overrides.server");
    return readOverrides(data.language);
  });

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data: roles } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .in("role", ["admin"]);
  if (!roles || roles.length === 0) throw new Error("Forbidden");
}

export const listTranslationOverrides = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => languageSchema.parse(data))
  .handler(async ({ data, context }): Promise<TranslationOverride[]> => {
    await assertAdmin(context);
    const { listOverrides } = await import("@/lib/translation-overrides.server");
    return listOverrides(data.language);
  });

export const saveTranslationOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveSchema.parse(data))
  .handler(async ({ data, context }): Promise<TranslationOverride> => {
    await assertAdmin(context);
    const { upsertOverride } = await import("@/lib/translation-overrides.server");
    return upsertOverride(data.language, data.sourceText, data.translatedText, context.userId);
  });

export const deleteTranslationOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => removeSchema.parse(data))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await assertAdmin(context);
    const { deleteOverride } = await import("@/lib/translation-overrides.server");
    await deleteOverride(data.language, data.sourceText);
    return { ok: true };
  });
