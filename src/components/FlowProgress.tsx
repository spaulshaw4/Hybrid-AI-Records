import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

export type FlowStep = {
  id: string;
  label: string;
  hint?: string;
};

type Props = {
  steps: FlowStep[];
  /** Zero-based index of the step currently in progress. */
  current: number;
  /** Shown when the next step is blocked by missing required fields. */
  blockedReason?: string;
  /** Called when a reachable step is activated with click, Enter or Space. */
  onStepSelect?: (index: number, step: FlowStep) => void;
  className?: string;
};

export function FlowProgress({
  steps,
  current,
  blockedReason,
  onStepSelect,
  className = "",
}: Props) {
  const total = steps.length;
  const clamped = Math.min(Math.max(current, 0), total - 1);
  const pct = total > 1 ? (clamped / (total - 1)) * 100 : 0;

  // Roving tabindex: the list is one tab stop and arrows move between steps.
  const [focusIndex, setFocusIndex] = useState(clamped);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const shouldFocusRef = useRef(false);

  useEffect(() => {
    setFocusIndex(clamped);
  }, [clamped]);

  useEffect(() => {
    if (!shouldFocusRef.current) return;
    shouldFocusRef.current = false;
    itemRefs.current[focusIndex]?.focus();
  }, [focusIndex]);

  const moveFocus = (next: number) => {
    const bounded = Math.min(Math.max(next, 0), total - 1);
    shouldFocusRef.current = true;
    setFocusIndex(bounded);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    // Horizontal list: Left/Right follow reading order; Up/Down mirror them.
    const isRtl = typeof document !== "undefined" && document.dir === "rtl";
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveFocus(index + (isRtl ? -1 : 1));
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(index + (isRtl ? 1 : -1));
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(index - 1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus(0);
        break;
      case "End":
        event.preventDefault();
        moveFocus(total - 1);
        break;
      default:
        break;
    }
  };

  const stateFor = (i: number) => (i < clamped ? "completed" : i === clamped ? "current" : "upcoming");

  const announcement = `Step ${clamped + 1} of ${total}: ${steps[clamped]?.label ?? ""}, ${
    stateFor(clamped) === "current" ? "in progress" : ""
  }${blockedReason ? `. ${blockedReason}` : "."}`;

  return (
    <nav
      aria-label="Application progress"
      className={`border border-border-strong bg-background/30 p-5 backdrop-blur-sm ${className}`}
    >
      <div className="flex items-center justify-between">
        <span
          id="flow-progress-heading"
          className="text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Application progress
        </span>
        <span className="text-xs font-semibold uppercase tracking-widest text-[#e11d2e]">
          Step {clamped + 1} of {total}
        </span>
      </div>

      {/* Non-visual summary of overall completion for assistive tech. */}
      <div
        role="progressbar"
        aria-labelledby="flow-progress-heading"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={clamped + 1}
        aria-valuetext={`Step ${clamped + 1} of ${total}: ${steps[clamped]?.label ?? ""}`}
        className="sr-only"
      />

      <div className="relative mt-5">
        <div className="absolute start-0 end-0 top-3 h-px bg-border/70" aria-hidden="true" />
        <div
          className="absolute start-0 top-3 h-px bg-[#e11d2e] transition-all duration-500"
          style={{ width: `${pct}%` }}
          aria-hidden="true"
        />
        <ol
          className="relative grid gap-3"
          style={{ gridTemplateColumns: `repeat(${total}, minmax(0,1fr))` }}
        >
          {steps.map((step, i) => {
            const state = stateFor(i);
            const done = state === "completed";
            const active = state === "current";
            const reachable = i <= clamped;
            const describedBy = blockedReason && i === clamped + 1 ? "flow-progress-blocked" : undefined;

            return (
              <li key={step.id} className="contents">
                <button
                  type="button"
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  tabIndex={i === focusIndex ? 0 : -1}
                  aria-current={active ? "step" : undefined}
                  aria-disabled={reachable ? undefined : true}
                  aria-describedby={describedBy}
                  onKeyDown={(event) => onKeyDown(event, i)}
                  onFocus={() => setFocusIndex(i)}
                  onClick={() => {
                    if (!reachable) return;
                    onStepSelect?.(i, step);
                  }}
                  className={`flex min-h-11 flex-col items-center rounded-sm text-center outline-none focus-visible:ring-2 focus-visible:ring-[#4b8bff] focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                    reachable && onStepSelect ? "cursor-pointer" : "cursor-default"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold transition-colors ${
                      done
                        ? "border-[#e11d2e] bg-[#e11d2e] text-white"
                        : active
                          ? "border-[#e11d2e] bg-background text-[#e11d2e] shadow-[0_0_18px_-4px_rgba(225,29,46,0.9)]"
                          : "border-border bg-background text-muted-foreground"
                    }`}
                  >
                    {done ? <Check size={13} strokeWidth={3} /> : i + 1}
                  </span>
                  <span
                    className={`mt-2 text-[11px] font-semibold uppercase tracking-wider ${
                      active
                        ? "text-white"
                        : done
                          ? "text-muted-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    {step.label}
                  </span>
                  <span className="sr-only">
                    {` — step ${i + 1} of ${total}, ${
                      done ? "completed" : active ? "current step" : "not yet available"
                    }`}
                  </span>
                  {step.hint && (
                    <span className="mt-1 hidden text-[11px] text-muted-foreground sm:block">
                      {step.hint}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {blockedReason && (
        <p
          id="flow-progress-blocked"
          className="mt-4 border-s-2 border-[#e11d2e] bg-[#e11d2e]/10 px-3 py-2 text-xs text-white"
        >
          {blockedReason}
        </p>
      )}

      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </nav>
  );
}
