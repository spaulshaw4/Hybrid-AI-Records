import { createServerFn } from "@tanstack/react-start";
import { aiChatFetch } from "@/lib/ai-chat.server";
import { aiChatUrl, aiFastModel, aiHeaders, hasExternalAiKey } from "@/lib/ai-provider.server";

/**
 * Machine translation for the site's visible copy. English is the source of
 * truth in the codebase; this endpoint renders it into the label's supported
 * languages on demand. Results are cached client-side, so a given phrase is
 * only ever translated once per language per visitor.
 */

const MAX_ITEMS = 120;
const MAX_CHARS = 12_000;

export type TranslateResult = { texts: string[] } | { error: string };

export const translateTexts = createServerFn({ method: "POST" })
  .inputValidator((data: { texts: string[]; target: string; targetLabel: string }) => {
    if (!Array.isArray(data.texts) || data.texts.length === 0) {
      throw new Error("Nothing to translate");
    }
    if (data.texts.length > MAX_ITEMS) throw new Error("Too many strings in one batch");
    const total = data.texts.reduce((sum, t) => sum + String(t).length, 0);
    if (total > MAX_CHARS) throw new Error("Batch too large");
    if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(data.target)) throw new Error("Invalid target language");
    return {
      texts: data.texts.map((t) => String(t)),
      target: data.target,
      targetLabel: String(data.targetLabel).slice(0, 60),
    };
  })
  .handler(async ({ data }): Promise<TranslateResult> => {
    if (!hasExternalAiKey()) return { error: "Translation service is not configured: set AI_API_KEY" };

    const payload = data.texts.map((text, i) => ({ i, text }));

    try {
      const res = await aiChatFetch({
        body: JSON.stringify({
          model: aiFastModel(),
          messages: [
            {
              role: "system",
              content:
                `You are a professional localizer for a music record label website. ` +
                `Translate each English string into ${data.targetLabel} (${data.target}). ` +
                `Rules: keep brand names, artist names, product names and acronyms ` +
                `(Hybrid AI Records, Stripe, Spotify, The Jester AI, HAR-codes, 4K, HD) untranslated. ` +
                `Preserve numbers, currency symbols, punctuation, capitalization style and ` +
                `leading/trailing spaces. Never add commentary. ` +
                `Return JSON only: {"items":[{"i":number,"text":string}]} with one entry per input, same order.`,
            },
            { role: "user", content: JSON.stringify({ items: payload }) },
          ],
          response_format: { type: "json_object" },
        }),
      });

      if (res.status === 429) return { error: "Translation rate limit reached — try again shortly" };
      if (res.status === 402) return { error: "Translation credits exhausted" };
      if (!res.ok) return { error: `Translation failed (${res.status})` };

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as { items?: Array<{ i: number; text: string }> };
      const out = data.texts.slice();
      for (const item of parsed.items ?? []) {
        if (typeof item?.i === "number" && typeof item?.text === "string" && out[item.i] !== undefined) {
          out[item.i] = item.text;
        }
      }
      return { texts: out };
    } catch {
      return { error: "Translation failed" };
    }
  });
