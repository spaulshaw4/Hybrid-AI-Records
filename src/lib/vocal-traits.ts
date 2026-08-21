/** Vocal gender + texture selectors that feed the engine `prompt`. */

export type VocalOption = { id: string; label: string; tags: string[] };

export const VOCAL_GENDERS: VocalOption[] = [
  { id: "male", label: "Male Vocals", tags: ["featuring male lead singer"] },
  { id: "female", label: "Female Vocals", tags: ["featuring female lead singer"] },
  { id: "duet", label: "Male/Female Duet", tags: ["featuring male and female duet", "harmony vocals"] },
];

export const VOCAL_STYLES: VocalOption[] = [
  { id: "raw-gritty", label: "Raw & Gritty", tags: ["raw gritty vocals"] },
  { id: "high-energy", label: "High Energy / Screaming", tags: ["screaming rock vocals", "high energy delivery"] },
  { id: "clean-melodic", label: "Clean & Melodic", tags: ["clean melodic vocals"] },
];

/** Trait tags for the current selections, de-duplicated in selector order. */
export function vocalTraitTags(genderId: string | null, styleId: string | null): string[] {
  const gender = VOCAL_GENDERS.find((o) => o.id === genderId)?.tags ?? [];
  const style = VOCAL_STYLES.find((o) => o.id === styleId)?.tags ?? [];
  const tags = [...gender, ...style];
  // Reinforce the vocal performance whenever the user picks anything.
  if (tags.length > 0) tags.push("powerful vocal performance");
  return Array.from(new Set(tags));
}
