import { useState } from "react";
import { Check, Sparkles, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  PROMPT_INSPIRATIONS,
  buildBriefFromInspirations,
  buildStyleFromInspirations,
  type PromptInspiration,
} from "@/lib/prompt-inspirations";

type Props = {
  /** Fills the studio inputs with the chosen preset. */
  onApply: (fill: { prompt: string; style: string; title: string }) => void;
};

/**
 * Quick-fill drawer of vocal-safe prompt presets. Select one or several styles
 * (e.g. Country + Hip-Hop) and apply them as a single blended, sung-vocal brief.
 */
export function PromptInspirations({ onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const chosen = PROMPT_INSPIRATIONS.filter((p) => selected.includes(p.id));

  const toggle = (preset: PromptInspiration) =>
    setSelected((prev) =>
      prev.includes(preset.id) ? prev.filter((id) => id !== preset.id) : [...prev, preset.id],
    );

  const apply = () => {
    if (chosen.length === 0) return;
    onApply({
      prompt: buildBriefFromInspirations(chosen),
      style: buildStyleFromInspirations(chosen),
      title: chosen.map((p) => p.label).join(" x "),
    });
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-full">
          <Wand2 className="mr-2 size-4" aria-hidden />
          AI Prompt Inspirations
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>AI Prompt Inspirations</SheetTitle>
          <SheetDescription>
            Pick one style — or combine several (Country + Hip-Hop) — to auto-fill your brief and
            style tags with blended BPM, instrument and vocal settings. Every blend forces a sung
            lead vocal, never an instrumental beat.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex-1 space-y-3 overflow-y-auto pb-4">
          {PROMPT_INSPIRATIONS.map((preset) => {
            const active = selected.includes(preset.id);
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={active}
                onClick={() => toggle(preset)}
                className={`flex w-full gap-3 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? "border-primary bg-primary/10"
                    : "border-border/60 bg-background/60 hover:border-primary/50 hover:bg-primary/5"
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border ${
                    active ? "border-primary bg-primary text-primary-foreground" : "border-border"
                  }`}
                >
                  {active ? <Check className="size-3.5" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{preset.label}</span>
                    <Badge variant="outline" className="border-primary/40 text-primary">
                      {preset.bpm}
                    </Badge>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{preset.brief}</span>
                  <span className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground/90">
                    <Sparkles className="mt-0.5 size-3 shrink-0 text-primary" aria-hidden />
                    <span>{preset.vocals}</span>
                  </span>
                  <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                    {preset.group}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="space-y-2 border-t border-border/60 pt-3">
          <p className="text-xs text-muted-foreground">
            {chosen.length === 0
              ? "Select at least one style to fill the studio."
              : `Blending: ${chosen.map((p) => p.label).join(" + ")}`}
          </p>
          <div className="flex gap-2">
            <Button type="button" className="flex-1" disabled={chosen.length === 0} onClick={apply}>
              Apply {chosen.length > 1 ? `${chosen.length} styles` : "style"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={chosen.length === 0}
              onClick={() => setSelected([])}
            >
              Clear
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default PromptInspirations;
