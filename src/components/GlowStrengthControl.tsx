import { Slider } from "@/components/ui/slider";
import {
  MAX_GLOW_STRENGTH,
  MIN_GLOW_STRENGTH,
  setGlowStrength,
  useGlowStrength,
} from "@/lib/glow-strength";

function label(value: number) {
  if (value <= 0.01) return "Off";
  if (value < 0.75) return "Subtle";
  if (value < 1.25) return "Default";
  if (value < 1.75) return "Strong";
  return "Maximum";
}

/** Slider that scales the crimson glow on headings and body copy site-wide. */
export function GlowStrengthControl() {
  const value = useGlowStrength();

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{label(value)}</span>
        <span aria-hidden="true">{Math.round(value * 100)}%</span>
      </div>
      <Slider
        value={[value]}
        min={MIN_GLOW_STRENGTH}
        max={MAX_GLOW_STRENGTH}
        step={0.05}
        aria-label="Crimson text glow strength"
        onValueChange={([next]) => setGlowStrength(next ?? 0)}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Optional crimson bloom on headings and buttons. Off by default to keep the interface easy on the eyes.
      </p>
    </div>
  );
}
