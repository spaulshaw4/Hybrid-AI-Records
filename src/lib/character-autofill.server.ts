/**
 * AI Auto-Fill for the Character Builder (server only).
 *
 * Gemini looks at the uploaded reference photo plus the track's title/genre and
 * proposes the lead character's identity: alias, archetype, physical
 * appearance and wardrobe anchors.
 */

import { throwGatewayError } from "./ai-error.server";
import { geminiGenerateContent } from "@/lib/gemini-native.server";
import { ORCHESTRATOR_VISION_MODEL } from "@/lib/orchestrator-models";



export type AutoFilledCharacter = {
  name: string;
  archetype: string;
  appearance: string;
  wardrobe: string;
};

export async function autoFillCharacter(input: {
  referenceImage: string | null;
  trackTitle: string;
  genre: string;
  styleMode: string;
  notes: string;
}): Promise<AutoFilledCharacter> {

  const system =
    "You are a music-video casting and wardrobe director. Given a reference photo " +
    "and the song's genre, invent a single consistent lead character for the film. " +
    'Return ONLY compact JSON: {"name":"","archetype":"","appearance":"","wardrobe":""}. ' +
    "name = a short stage alias (2-3 words). archetype = the role in one short phrase. " +
    "appearance = build, hair/beard, face, skin, age range and demeanour in one dense " +
    "sentence, faithful to the photo when one is supplied. wardrobe = signature garments, " +
    "materials, colours and accessories that stay identical in every shot. " +
    "Keep everything period- and genre-appropriate. No markdown fences, no commentary.";

  const lines = [
    input.trackTitle.trim() ? `Track title: ${input.trackTitle.trim()}` : "Track title: untitled",
    `Genre: ${input.genre || "unspecified"}`,
    `Visual style: ${input.styleMode || "photorealistic"}`,
    ...(input.notes.trim() ? [`Director's notes: ${input.notes.trim().slice(0, 1200)}`] : []),
    input.referenceImage
      ? "A reference photo of the intended lead is attached — describe THAT person."
      : "No reference photo was supplied — invent a character that fits the genre.",
  ];

  const parts: Array<Record<string, unknown>> = [{ text: lines.join("\n") }];
  if (input.referenceImage) {
    const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/.exec(input.referenceImage);
    if (match?.[1] && match[2]) {
      parts.push({
        inlineData: {
          mimeType: match[1] === "image/jpg" ? "image/jpeg" : match[1],
          data: match[2],
        },
      });
    }
  }

  const response = await geminiGenerateContent({
    model: ORCHESTRATOR_VISION_MODEL,
    label: "Character assistant",
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" },
    },
  });

  if (!response.ok) await throwGatewayError(response, "Character assistant");

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/, "")
    .trim();

  let parsed: Partial<AutoFilledCharacter> = {};
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    parsed = JSON.parse(start >= 0 ? text.slice(start, end + 1) : text) as AutoFilledCharacter;
  } catch {
    throw new Error("The character assistant returned an unreadable profile. Try again.");
  }

  const str = (value: unknown, max: number) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";

  const result: AutoFilledCharacter = {
    name: str(parsed.name, 80),
    archetype: str(parsed.archetype, 120),
    appearance: str(parsed.appearance, 800),
    wardrobe: str(parsed.wardrobe, 600),
  };
  if (!result.name && !result.appearance)
    throw new Error("The character assistant returned nothing. Try again.");
  return result;
}
