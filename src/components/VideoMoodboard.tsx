import { memo } from "react";
import { ImageIcon, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConceptPreview, type ConceptPreviewValue } from "@/components/ConceptPreview";
import { hasCharacterProfile, type CharacterProfile } from "@/lib/character-profile";
import { CharacterAnchorFrame } from "@/components/CharacterAnchorFrame";

type Props = {
  concept: ConceptPreviewValue | null;
  character?: CharacterProfile | null;
  costLabel: string;
  busy?: boolean;
  building?: boolean;
  disabled?: boolean;
  onBuild: () => void;
  onEdit: () => void;
  onStart: () => void;
};

/**
 * Concept preview step. The look direction now lives in the Style card
 * (dropdown + Gemini style tuning), so this is purely the free preview of the
 * character close-ups, framing and narrative before V Tokens are charged.
 */
function VideoMoodboardBase({
  concept,
  character = null,
  costLabel,
  busy = false,
  building = false,
  disabled = false,
  onBuild,
  onEdit,
  onStart,
}: Props) {
  const locked = disabled || busy;

  return (
    <div className="space-y-6">
      {!concept && hasCharacterProfile(character) && (
        <CharacterAnchorFrame character={character} />
      )}

      {!concept && (
        <div className="space-y-3 rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
          <ImageIcon className="mx-auto size-7 text-primary" aria-hidden />
          <p className="text-sm font-medium">No concept preview yet</p>
          <p className="text-xs text-muted-foreground">
            Preview the concept to see character close-ups, environmental framing and the full
            narrative before any V Tokens are spent.
          </p>
          <Button type="button" disabled={locked || building} onClick={onBuild}>
            {building ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-4" aria-hidden />
            )}
            {building ? "Building your concept…" : "Preview Concept — free"}
          </Button>
        </div>
      )}

      {concept && (
        <ConceptPreview
          concept={concept}
          character={character}
          costLabel={costLabel}
          busy={busy || building}
          onEdit={onEdit}
          onStart={onStart}
        />
      )}
    </div>
  );
}


/** Memoised: the studio route re-renders often; this view only repaints when its own props change. */
export const VideoMoodboard = memo(VideoMoodboardBase);
export default VideoMoodboard;
