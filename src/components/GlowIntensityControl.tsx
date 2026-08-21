import {
  GLOW_INTENSITIES,
  setGlowIntensity,
  useGlowIntensity,
  type GlowIntensity,
} from "@/lib/glow-intensity";

/**
 * Three-way saturation preset for the red/white/blue glow. Rendered as a
 * radiogroup so keyboard and screen-reader users get proper semantics.
 */
export function GlowIntensityControl() {
  const value = useGlowIntensity();
  const active = GLOW_INTENSITIES.find((o) => o.value === value);

  return (
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label="Glow intensity"
        className="grid grid-cols-3 gap-1 rounded-md border border-border-strong p-1"
      >
        {GLOW_INTENSITIES.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              title={option.hint}
              onClick={() => setGlowIntensity(option.value as GlowIntensity)}
              className={`min-h-11 rounded px-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {active?.hint} Colour only — glow animations stay off when your device
        requests reduced motion.
      </p>
    </div>
  );
}
