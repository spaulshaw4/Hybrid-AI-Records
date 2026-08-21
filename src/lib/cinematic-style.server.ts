import { aiChatFetch } from "@/lib/ai-chat.server";
import { aiChatUrl, aiHeaders, aiTextModel } from "@/lib/ai-provider.server";
/**
 * Gemini style-prompt tuning (server only).
 *
 * Turns the chosen visual style (plus whatever the script already says) into a
 * tight, production-ready look direction paragraph that is baked into every
 * scene of the render.
 */




export async function writeStyleDirection(input: {
  styleMode: string;
  script: string;
  notes: string;
}): Promise<string> {

  const system =
    "You are a cinematographer writing the look direction for a music video. " +
    "Return ONLY one dense paragraph (max 600 characters): colour grade, lighting, " +
    "lens and camera language, texture/grain and any hard 'avoid' notes. " +
    "No markdown, no headings, no lists.";

  const user = [
    `Chosen visual style: ${input.styleMode}.`,
    input.notes.trim() ? `Existing look notes to refine: ${input.notes.trim().slice(0, 1200)}` : "",
    input.script.trim() ? `Script excerpt for context:\n${input.script.trim().slice(0, 2500)}` : "",
    "Write the tuned look direction now.",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await aiChatFetch(
    // Visual Engine — PAID key only (GOOGLE_PAID_API_KEY).
    {
    body: JSON.stringify({
      model: aiTextModel(),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    },
    { label: "Style tuning", tier: "paid" },
  );

  if (response.status === 429) throw new Error("Style tuning is busy. Try again in a moment.");
  if (response.status === 402)
    throw new Error("AI credits are exhausted. Add credits and try again.");
  if (!response.ok) throw new Error("Style tuning couldn't finish that pass.");

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
  const clean = text.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  if (clean.length < 20) throw new Error("Style tuning returned nothing. Try again.");
  return clean.slice(0, 900);
}
