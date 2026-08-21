import { memo, useRef, useState } from "react";
import { Sparkles, UserPlus, Wand2, X } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { fileToReferenceImage } from "@/lib/reference-image";
import { autoFillCharacterProfile } from "@/lib/character-autofill.functions";
import type { CharacterProfile } from "@/lib/character-profile";

type Props = {
  value: CharacterProfile;
  onChange: (next: CharacterProfile) => void;
  disabled?: boolean;
  /** Track title + genre + style give the auto-fill its context. */
  trackTitle?: string;
  genre?: string;
  styleMode?: string;
  notes?: string;
};

/** Quick-style chips: one click drops the keywords into look + wardrobe. */
const STYLE_CHIPS: { label: string; appearance: string; wardrobe: string }[] = [
  {
    label: "Gritty Outlaw",
    appearance: "weathered face, sun-cracked skin, hard stare, dust in the hair",
    wardrobe: "worn leather jacket, faded denim, scuffed boots, silver rings",
  },
  {
    label: "High-Contrast Stage",
    appearance: "sweat-lit skin, sharp shadows across the face, performance energy",
    wardrobe: "matte black stage outfit, harness straps, in-ear monitor pack",
  },
  {
    label: "Cinematic Golden Hour",
    appearance: "warm backlit hair rim, soft skin highlights, relaxed open posture",
    wardrobe: "light linen shirt, sun-bleached tones, simple leather cord necklace",
  },
  {
    label: "Rustic Workwear",
    appearance: "calloused hands, tanned forearms, unpolished natural look",
    wardrobe: "canvas work jacket, flannel shirt, heavy denim, worn work boots",
  },
  {
    label: "Neo-Noir Street",
    appearance: "wet-lit cheekbones, guarded expression, cropped silhouette",
    wardrobe: "long dark coat, high collar, rain-slick fabric, dark gloves",
  },
  {
    label: "Southern Gospel",
    appearance: "warm dignified presence, open expressive face, steady gaze",
    wardrobe: "pressed suit, clean white shirt, polished shoes, simple cross",
  },
];

/**
 * Character Builder: the pre-render identity panel. Whatever is set here is
 * injected into every storyboard prompt and used as the visual anchor image.
 */
function CharacterBuilderBase({
  value,
  onChange,
  disabled = false,
  trackTitle,
  genre,
  styleMode,
  notes,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const autoFill = useServerFn(autoFillCharacterProfile);
  const [filling, setFilling] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const set = (patch: Partial<CharacterProfile>) => onChange({ ...value, ...patch });

  const append = (field: "appearance" | "wardrobe", text: string) => {
    const current = value[field].trim();
    if (current.toLowerCase().includes(text.toLowerCase())) return current;
    return current ? `${current}, ${text}` : text;
  };

  const applyChip = (chip: (typeof STYLE_CHIPS)[number]) => {
    set({
      appearance: append("appearance", chip.appearance).slice(0, 800),
      wardrobe: append("wardrobe", chip.wardrobe).slice(0, 600),
    });
  };

  const runAutoFill = async () => {
    setFilling(true);
    setAssistantError(null);
    try {
      const result = await autoFill({
        data: {
          referenceImage: value.referenceImage,
          trackTitle: trackTitle ?? "",
          genre: genre ?? "",
          styleMode: styleMode ?? "",
          notes: notes ?? "",
        },
      });
      if (!result.ok) {
        setAssistantError(result.error);
        return;
      }
      onChange({
        ...value,
        name: result.profile.name || value.name,
        archetype: result.profile.archetype || value.archetype,
        appearance: result.profile.appearance || value.appearance,
        wardrobe: result.profile.wardrobe || value.wardrobe,
      });
      toast.success("Character profile filled in — edit anything you want to change.");
    } catch {
      setAssistantError("Auto-fill couldn't run. Your session may need to be renewed.");
    } finally {
      setFilling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
        <p className="text-xs text-muted-foreground">
          Let the AI read your reference photo and the track, then write the whole profile.
        </p>
        <Button
          type="button"
          size="sm"
          disabled={disabled || filling}
          onClick={() => void runAutoFill()}
        >
          {filling ? (
            <Wand2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-4" aria-hidden />
          )}
          {filling ? "Reading the photo…" : "AI Auto-Fill"}
        </Button>
      </div>
      {assistantError ? (
        <Alert variant="destructive" className="bg-card/90">
          <AlertTitle>Character Assistant unavailable</AlertTitle>
          <AlertDescription>{assistantError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="char-name" className="text-xs uppercase tracking-wide">
            Character name / alias
          </Label>
          <Input
            id="char-name"
            value={value.name}
            disabled={disabled}
            maxLength={80}
            placeholder="e.g. Dusty Ray"
            aria-label="Character name or alias"
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="char-archetype" className="text-xs uppercase tracking-wide">
            Archetype / role
          </Label>
          <Input
            id="char-archetype"
            value={value.archetype}
            disabled={disabled}
            maxLength={120}
            placeholder="e.g. Lead singer, street performer, outlaw"
            aria-label="Character archetype or role"
            onChange={(e) => set({ archetype: e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="char-appearance" className="text-xs uppercase tracking-wide">
          Physical appearance &amp; style
        </Label>
        <Textarea
          id="char-appearance"
          value={value.appearance}
          disabled={disabled}
          maxLength={800}
          rows={3}
          placeholder="Wardrobe, build, hair/beard, signature accessories (hat, sunglasses, rings)…"
          aria-label="Character physical appearance and style"
          onChange={(e) => set({ appearance: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="char-wardrobe" className="text-xs uppercase tracking-wide">
          Wardrobe anchors
        </Label>
        <Textarea
          id="char-wardrobe"
          value={value.wardrobe}
          disabled={disabled}
          maxLength={600}
          rows={2}
          placeholder="Signature garments, colours and accessories repeated in every shot…"
          aria-label="Character wardrobe anchors"
          onChange={(e) => set({ wardrobe: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Quick-style presets</p>
        <div className="flex flex-wrap gap-2">
          {STYLE_CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              disabled={disabled}
              aria-label={`Add ${chip.label} styling keywords`}
              onClick={() => applyChip(chip)}
              className="rounded-full border border-border bg-muted/30 px-3 py-1 text-xs font-medium transition hover:border-primary/60 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4 rounded-xl border border-dashed border-border bg-muted/20 p-4">
        {value.referenceImage ? (
          <img
            src={value.referenceImage}
            alt={`${value.name || "Character"} reference`}
            className="size-20 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="flex size-20 shrink-0 items-center justify-center rounded-lg bg-muted">
            <UserPlus className="size-6 text-muted-foreground" aria-hidden />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {value.referenceImage ? "Visual anchor locked in" : "Reference image (avatar)"}
          </p>
          <p className="text-xs text-muted-foreground">
            This photo conditions every shot and the lip-sync pass, so the same face carries the
            whole film.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
            >
              {value.referenceImage ? "Replace photo" : "Upload photo"}
            </Button>
            {value.referenceImage && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => set({ referenceImage: null })}
              >
                <X className="size-4" aria-hidden /> Remove
              </Button>
            )}
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label="Upload character reference image"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              set({ referenceImage: await fileToReferenceImage(file) });
              toast.success("Character reference locked in.");
            } catch {
              toast.error("That image couldn't be read. Try a JPG or PNG.");
            }
          }}
        />
      </div>
    </div>
  );
}


/** Memoised: the studio route re-renders often; this view only repaints when its own props change. */
export const CharacterBuilder = memo(CharacterBuilderBase);
export default CharacterBuilder;
