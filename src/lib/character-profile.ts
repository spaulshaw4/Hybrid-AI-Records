/**
 * Character Builder profile.
 *
 * The producer defines the lead subject once (name, archetype, look and a
 * reference photo) and that profile is injected into every Gemini shot prompt
 * and used as the visual conditioning image for the render and lip-sync calls.
 */

export type CharacterProfile = {
  /** Character name or stage alias. */
  name: string;
  /** Archetype / role: lead singer, street performer, outlaw… */
  archetype: string;
  /** Wardrobe, build, hair/beard, signature accessories. */
  appearance: string;
  /** Signature wardrobe anchors that must repeat in every shot. */
  wardrobe: string;
  /** Base64 data-URL avatar used as the visual anchor. */
  referenceImage: string | null;
};

export const EMPTY_CHARACTER: CharacterProfile = {
  name: "",
  archetype: "",
  appearance: "",
  wardrobe: "",
  referenceImage: null,
};

/** True when the producer supplied anything worth injecting into prompts. */
export function hasCharacterProfile(profile: CharacterProfile | null | undefined): boolean {
  if (!profile) return false;
  return Boolean(
    profile.name.trim() ||
      profile.archetype.trim() ||
      profile.appearance.trim() ||
      profile.wardrobe.trim() ||
      profile.referenceImage,
  );
}

/** Trims and clamps a profile coming off the wire. */
export function sanitizeCharacterProfile(input: unknown): CharacterProfile | null {
  const raw = input as Partial<Record<keyof CharacterProfile, unknown>> | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  const text = (value: unknown, max: number) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
  const image =
    typeof raw.referenceImage === "string" &&
    /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.referenceImage) &&
    raw.referenceImage.length <= 3_000_000
      ? raw.referenceImage
      : null;
  const profile: CharacterProfile = {
    name: text(raw.name, 80),
    archetype: text(raw.archetype, 120),
    appearance: text(raw.appearance, 800),
    wardrobe: text(raw.wardrobe, 600),
    referenceImage: image,
  };
  return hasCharacterProfile(profile) ? profile : null;
}

/** Display name used in prompts and on the concept board. */
export function characterDisplayName(profile: CharacterProfile): string {
  return profile.name.trim() || profile.archetype.trim() || "the lead character";
}

/**
 * Wardrobe continuity lock. These tokens repeat verbatim in every shot prompt
 * so the lead never changes costume between blocks.
 */
export const WARDROBE_LOCK_TOKENS =
  "Stephen Shaw, white crewneck t-shirt, dark denim jeans, black belt, white sneakers, " +
  "rectangular half-rim glasses, groomed beard, slicked-back undercut fade";

/**
 * Hard prompt directive: every shot featuring the subject must name and
 * describe this exact character so the 33 blocks stay one continuous person.
 */
export function characterDirective(profile: CharacterProfile | null | undefined): string {
  if (!profile || !hasCharacterProfile(profile)) return "";
  const name = characterDisplayName(profile);
  const parts = [`LEAD CHARACTER (mandatory): ${name}.`];
  if (profile.archetype.trim()) parts.push(`Role/archetype: ${profile.archetype.trim()}.`);
  if (profile.appearance.trim())
    parts.push(`Appearance and signature details: ${profile.appearance.trim()}.`);
  parts.push(
    `Wardrobe anchors (identical in every shot, never a costume change): ${
      profile.wardrobe.trim() || WARDROBE_LOCK_TOKENS
    }.`,
  );

  if (profile.referenceImage)
    parts.push(
      "A reference photo of this character is supplied as the visual anchor — keep their face, hair and wardrobe identical in every shot.",
    );
  parts.push(
    `Every shot that features the subject must explicitly name them, e.g. "Featuring ${name}, ${
      profile.appearance.trim() ? profile.appearance.trim().slice(0, 160) : "in their signature look"
    }". ` +
      "Never invent a different lead, a different name or a different wardrobe.",
  );
  return parts.join(" ");
}
