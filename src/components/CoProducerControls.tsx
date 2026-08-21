import { useState } from "react";
import { Loader2, RotateCcw, Send, Sparkles } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import {
  tuneCinematicScript,
  type CinematicTuneDirective,
} from "@/lib/cinematic-tune.functions";

const GROUPS: { label: string; controls: { id: CinematicTuneDirective; label: string }[] }[] = [
  {
    label: "Tone & pace",
    controls: [
      { id: "cinematic", label: "More cinematic" },
      { id: "tighter", label: "Tighter cuts" },
      { id: "darker", label: "Darker tone" },
      { id: "brighter", label: "Brighter tone" },
      { id: "action", label: "More action" },
      { id: "emotion", label: "Deeper emotion" },
    ],
  },
  {
    label: "Craft",
    controls: [
      { id: "camera", label: "Camera language" },
      { id: "lighting", label: "Lighting design" },
      { id: "detail", label: "More detail" },
      { id: "location", label: "Vary locations" },
      { id: "performance", label: "Performance focus" },
      { id: "symbolism", label: "Add symbolism" },
    ],
  },
  {
    label: "Structure",
    controls: [
      { id: "narrative", label: "Stronger story" },
      { id: "hook", label: "Rebuild opening" },
      { id: "ending", label: "Rewrite ending" },
      { id: "simplify", label: "Simplify" },
    ],
  },
];

const INTENSITY_LABELS = ["Polish", "Refine", "Balanced", "Strong", "Aggressive"];

type Props = {
  script: string;
  styleMode: string;
  subjectMode: string;
  onScript: (next: string) => void;
  disabled?: boolean;
};

/**
 * Hybrid AI Co-Producer: real-time prompt tuning. Every control rewrites the
 * live script in place at a chosen intensity, a free-form producer note can
 * steer the rewrite, and the last few versions can be restored.
 */
export function CoProducerControls({ script, styleMode, subjectMode, onScript, disabled }: Props) {
  const tune = useServerFn(tuneCinematicScript);
  const [busy, setBusy] = useState<CinematicTuneDirective | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [intensity, setIntensity] = useState(3);
  const [instruction, setInstruction] = useState("");

  const run = async (directive: CinematicTuneDirective) => {
    if (script.trim().length < 40) {
      toast.error("Add a longer script before tuning it.");
      return;
    }
    setBusy(directive);
    const before = script;
    try {
      const result = await tune({
        data: { script, directive, styleMode, subjectMode, intensity, instruction },
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setHistory((prev) => [before, ...prev].slice(0, 5));
      onScript(result.script);
      toast.success("Script tuned by the Hybrid AI Co-Producer.");
    } catch {
      toast.error("Sign in to use the Co-Producer.");
    } finally {
      setBusy(null);
    }
  };

  const undo = () => {
    const [previous, ...rest] = history;
    if (!previous) return;
    onScript(previous);
    setHistory(rest);
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="size-4 text-primary" aria-hidden />
          Hybrid AI Co-Producer — real-time tuning
        </p>
        {history.length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={undo}>
            <RotateCcw className="size-3.5" aria-hidden /> Undo ({history.length})
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium" htmlFor="coproducer-intensity">
            Rewrite intensity
          </label>
          <span className="text-xs font-semibold text-primary">
            {INTENSITY_LABELS[intensity - 1]}
          </span>
        </div>
        <Slider
          id="coproducer-intensity"
          aria-label="Rewrite intensity"
          min={1}
          max={5}
          step={1}
          value={[intensity]}
          disabled={disabled || busy !== null}
          onValueChange={(vals: number[]) => setIntensity(vals[0] ?? 3)}
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium" htmlFor="coproducer-note">
          Producer note (optional) — steers every adjustment
        </label>
        <Textarea
          id="coproducer-note"
          rows={2}
          maxLength={600}
          value={instruction}
          disabled={disabled || busy !== null}
          placeholder="e.g. keep the sister character, move act two to a rain-soaked rooftop, no crowd scenes…"
          onChange={(e) => setInstruction(e.target.value)}
        />
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={disabled || busy !== null || instruction.trim().length < 4}
            onClick={() => void run("cinematic")}
          >
            {busy === "cinematic" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Send className="size-3.5" aria-hidden />
            )}
            Apply note
          </Button>
        </div>
      </div>

      {GROUPS.map((group) => (
        <div key={group.label} className="space-y-2 border-t border-border pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group.label}
          </p>
          <div className="flex flex-wrap gap-2">
            {group.controls.map((control) => (
              <Button
                key={control.id}
                type="button"
                size="sm"
                variant="outline"
                className="rounded-full"
                disabled={disabled || busy !== null}
                onClick={() => void run(control.id)}
              >
                {busy === control.id ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : null}
                {control.label}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default CoProducerControls;
