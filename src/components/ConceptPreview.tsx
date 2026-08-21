import { memo } from "react";
import { ImageIcon, Pencil, Sparkles, UserRound, Mountain } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  hasCharacterProfile,
  type CharacterProfile,
} from "@/lib/character-profile";
import { CharacterAnchorFrame } from "@/components/CharacterAnchorFrame";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type ConceptFrameView = {
  id: string;
  kind: "character" | "environment";
  title: string;
  description: string;
  image: string | null;
};

export type ConceptPreviewValue = {
  logline: string;
  narrative: string;
  styleTags: string[];
  frames: ConceptFrameView[];
};

/**
 * Video Moodboard: the approval step between the script and the paid render.
 * Shows character close-ups, environmental framing, craft tags and the full
 * narrative/visual description, then hands off to Start Generation.
 */
function ConceptPreviewBase({
  concept,
  character = null,
  costLabel,
  busy = false,
  onEdit,
  onStart,
}: {
  concept: ConceptPreviewValue;
  /** Character Builder profile, shown as the locked lead of this concept. */
  character?: CharacterProfile | null;
  costLabel: string;
  busy?: boolean;
  onEdit: () => void;
  onStart: () => void;
}) {
  const characters = concept.frames.filter((f) => f.kind === "character");
  const environments = concept.frames.filter((f) => f.kind === "environment");

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ImageIcon className="size-5 text-primary" aria-hidden />
          Video Moodboard — concept preview
        </CardTitle>
        <CardDescription>
          Review the look before any V Tokens are spent. Edit the script, style or mood board to
          re-run this preview, or start the render.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {concept.logline && (
          <p className="text-sm font-medium text-foreground">{concept.logline}</p>
        )}

        {hasCharacterProfile(character) && (
          <CharacterAnchorFrame
            character={character}
            label="Locked Visual Reference"
            size="lg"
            note="This is the target subject: the exact photo bound to every shot in the render."
          />
        )}

        {concept.styleTags.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Style tags">
            {concept.styleTags.map((tag) => (
              <li
                key={tag}
                className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}

        {[
          { key: "character", label: "Character close-ups", icon: UserRound, frames: characters },
          { key: "environment", label: "Environmental framing", icon: Mountain, frames: environments },
        ]
          .filter((group) => group.frames.length > 0)
          .map((group) => (
            <div key={group.key} className="space-y-3">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <group.icon className="size-4 text-primary" aria-hidden />
                {group.label}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {group.frames.map((frame) => (
                  <figure
                    key={frame.id}
                    className="overflow-hidden rounded-xl border border-border bg-muted/30"
                  >
                    {frame.image ? (
                      <img
                        src={frame.image}
                        alt={`${frame.title} — concept frame`}
                        loading="lazy"
                        className="aspect-video w-full object-cover"
                      />
                    ) : (
                      <div className="flex aspect-video w-full items-center justify-center bg-muted text-xs text-muted-foreground">
                        Frame preview unavailable
                      </div>
                    )}
                    <figcaption className="space-y-1 p-3">
                      <p className="text-sm font-semibold">{frame.title}</p>
                      <p className="text-xs text-muted-foreground">{frame.description}</p>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ))}

        {concept.narrative && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Narrative &amp; visual description
            </p>
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">
              {concept.narrative}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row">
          <Button type="button" variant="outline" className="sm:flex-1" onClick={onEdit} disabled={busy}>
            <Pencil className="size-4" aria-hidden /> Edit concept
          </Button>
          <Button type="button" className="font-semibold sm:flex-1" onClick={onStart} disabled={busy}>
            <Sparkles className="size-4" aria-hidden /> Spend {costLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Memoised: the studio route re-renders often; this view only repaints when its own props change. */
export const ConceptPreview = memo(ConceptPreviewBase);
