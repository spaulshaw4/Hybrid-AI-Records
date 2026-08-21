import { memo } from "react";
import { ImageOff, ShieldCheck } from "lucide-react";

import { characterDisplayName, type CharacterProfile } from "@/lib/character-profile";

type Props = {
  character: CharacterProfile | null;
  /** Card label — e.g. "Primary Anchor Frame" or "Locked Visual Reference". */
  label?: string;
  /** Shown under the label. */
  note?: string;
  /** Larger frame for the pre-flight confirmation card. */
  size?: "sm" | "lg";
};

/**
 * The single source of truth for the character anchor image on screen.
 *
 * Whatever is rendered here is exactly the photo bound to the render payload
 * as the image-to-video conditioning frame for every shot, so the same
 * component is reused in the setup panel and in the pre-render review card.
 */
function CharacterAnchorFrameBase({
  character,
  label = "Primary Anchor Frame",
  note,
  size = "sm",
}: Props) {
  const image = character?.referenceImage ?? null;
  const box = size === "lg" ? "size-28 sm:size-32" : "size-20";

  return (
    <div className="flex items-start gap-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
      {image ? (
        <img
          src={image}
          /* Keyed on the data URL so swapping the photo repaints instantly. */
          key={image.slice(-48)}
          alt={`${character ? characterDisplayName(character) : "Character"} — locked visual reference`}
          className={`${box} shrink-0 rounded-lg border border-primary/40 object-cover`}
        />
      ) : (
        <div
          className={`${box} flex shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-muted text-center`}
        >
          <ImageOff className="size-5 text-muted-foreground" aria-hidden />
          <span className="px-1 text-[10px] leading-tight text-muted-foreground">No photo yet</span>
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
          <ShieldCheck className="size-3.5" aria-hidden />
          {label}
        </p>
        <p className="text-sm font-semibold text-foreground">
          {character ? characterDisplayName(character) : "No character set"}
          {character?.archetype ? ` — ${character.archetype}` : ""}
        </p>
        {character?.appearance ? (
          <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
            {character.appearance}
          </p>
        ) : null}
        {character?.wardrobe ? (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            Wardrobe: {character.wardrobe}
          </p>
        ) : null}
        <p className="pt-1 text-[11px] text-muted-foreground">
          {note ??
            (image
              ? "This exact frame conditions every shot in the render."
              : "Upload a reference photo to lock the subject for every shot.")}
        </p>
      </div>
    </div>
  );
}


/** Memoised: the studio route re-renders often; this view only repaints when its own props change. */
export const CharacterAnchorFrame = memo(CharacterAnchorFrameBase);
export default CharacterAnchorFrame;
