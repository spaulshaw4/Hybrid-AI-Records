import { aiChatFetch } from "@/lib/ai-chat.server";
import { aiChatUrl, aiHeaders, aiFastModel } from "@/lib/ai-provider.server";
/**
 * Co-Producer script tuning (server only).
 *
 * Powers the one-tap tuning buttons in the Visual Engine: the current script
 * is rewritten in place against a named directive, so a producer can push the
 * treatment darker, tighter or more action-led without retyping it.
 */



export const TUNE_DIRECTIVES = {
  cinematic: "Raise the cinematic craft: stronger visual language, camera blocking and lighting cues.",
  tighter: "Tighten the pacing: shorter beats, faster cuts, remove filler and repetition.",
  darker: "Push the tone darker and more aggressive: heavier contrast, tension and grit.",
  brighter: "Lift the tone: warmer, hopeful, more uplifting imagery and light.",
  action: "Add kinetic action: movement, stunts, dynamic camera and escalating momentum.",
  emotion: "Deepen the emotional arc: character interiority, stakes and a clear turn.",
  detail: "Expand the visual detail: wardrobe, location texture, props and colour palette.",
  simplify: "Simplify: fewer locations and characters, one clear through-line.",
  performance:
    "Foreground the performance: lip-sync coverage, artist presence to camera, stage and crowd energy.",
  narrative:
    "Strengthen the narrative spine: clear setup, escalation and payoff with a defined protagonist goal.",
  location:
    "Diversify the locations: distinct, contrasting environments with their own light and texture.",
  camera:
    "Specify the camera language: lens choice, height, movement and transitions for each beat.",
  lighting:
    "Specify the lighting design: key direction, practicals, contrast ratio and colour temperature.",
  symbolism:
    "Layer in visual symbolism and recurring motifs that pay off by the final beat.",
  hook: "Rebuild the opening: a magnetic first eight seconds that states the world and the stakes.",
  ending: "Rewrite the ending: a decisive, memorable final image that lands the theme.",
} as const;

export type TuneDirective = keyof typeof TUNE_DIRECTIVES;

/** How hard the rewrite pushes: 1 = gentle polish, 5 = aggressive rework. */
const INTENSITY = [
  "Make a light, surgical pass — keep 90% of the wording intact.",
  "Make a modest pass — refine wording and add a few concrete details.",
  "Make a balanced pass — rework weak beats while keeping the structure.",
  "Make a strong pass — rewrite freely, reorder beats where it improves the film.",
  "Make an aggressive pass — a bold reinterpretation that keeps only the core story and characters.",
] as const;

export async function tuneScript(input: {
  script: string;
  directive: TuneDirective;
  styleMode: string;
  subjectMode: string;
  intensity?: number;
  instruction?: string;
}): Promise<string> {
  const level = Math.max(1, Math.min(5, Math.round(input.intensity ?? 3)));
  const custom = (input.instruction ?? "").trim();


  const response = await aiChatFetch(
    // Visual Engine — PAID key only (GOOGLE_PAID_API_KEY).
    {
    body: JSON.stringify({
      model: aiFastModel(),
      messages: [
        {
          role: "system",
          content:
            "You are a music-video co-producer. Rewrite the user's treatment or script in place, " +
            "keeping its story, characters and language. Return ONLY the rewritten script text — " +
            "no preamble, no headings, no commentary, no markdown fences.",
        },
        {
          role: "user",
          content: [
            `Adjustment: ${TUNE_DIRECTIVES[input.directive]}`,
            `Rewrite intensity ${level}/5: ${INTENSITY[level - 1]}`,
            ...(custom ? [`Producer note (highest priority): ${custom.slice(0, 600)}`] : []),
            `Visual style: ${input.styleMode}. Subject mode: ${input.subjectMode}.`,
            "Script:",
            input.script.slice(0, 15000),
          ].join("\n"),

        },
      ],
    }),
    },
    { label: "Co-Producer tune", tier: "paid" },
  );

  if (response.status === 429) throw new Error("The Co-Producer is busy. Try again in a moment.");
  if (response.status === 402) throw new Error("AI credits are exhausted. Add credits and try again.");
  if (!response.ok) throw new Error("The Co-Producer couldn't rewrite that script.");

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
  const clean = text.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  if (clean.length < 20) throw new Error("The Co-Producer returned an empty rewrite. Try again.");
  return clean.slice(0, 15000);
}
