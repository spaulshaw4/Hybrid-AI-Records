import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { toast } from "sonner";
import { CURRENCIES, CURRENCY_CODES, setCurrency, useCurrency } from "@/lib/currency";
import { SettingsError, settingsErrorMessage } from "@/lib/settings-error";
import { surchargePercent, type CurrencyCode } from "@/lib/pricing";

/**
 * Applies a currency change and reports any failure to the visitor instead of
 * silently doing nothing.
 */
function applyCurrency(code: CurrencyCode) {
  try {
    setCurrency(code);
    const info = CURRENCIES[code];
    toast.success(`Currency set to ${info.label} (${info.code.toUpperCase()})`);
  } catch (error) {
    const applied = error instanceof SettingsError && error.applied;
    toast.error(applied ? "Currency not saved" : "Couldn't change currency", {
      description: settingsErrorMessage(error),
    });
  }
}


/**
 * Lets a visitor override the auto-detected currency. Prices across the site
 * re-render instantly because they all read the same store.
 *
 * Two presentations share one state:
 *  - narrow containers (mobile) get a real listbox dropdown that expands *in
 *    flow*, so it pushes CTAs down instead of covering them;
 *  - wide containers keep the inline toggle group.
 * Only one presentation is in the DOM flow at a time (`hidden` removes the
 * other from the tab order), so keyboard users never traverse duplicates.
 */
export function CurrencySwitcher({
  className = "",
  variant = "full",
}: {
  className?: string;
  variant?: "full" | "pill";
}) {
  const currency = useCurrency();
  const surcharge = surchargePercent(currency);

  if (variant === "pill") {
    return (
      <div className={`shrink-0 ${className}`}>
        <CurrencyDropdown currency={currency} surcharge={surcharge} compact />
      </div>
    );
  }

  return (
    <div className={`@container w-full max-w-full min-w-0 ${className}`}>
      {/* Mobile / narrow container: accessible dropdown */}
      <div className="block @[30rem]:hidden">
        <CurrencyDropdown currency={currency} surcharge={surcharge} />
      </div>

      {/* Wide container: inline toggle group */}
      <div className="hidden @[30rem]:block">
        <div className="inline-flex w-auto max-w-full flex-nowrap items-center gap-x-2 gap-y-1 border border-border bg-background/40 px-2 py-1 backdrop-blur-sm">
          <Globe className="size-3.5 shrink-0 text-[#e11d2e]" aria-hidden="true" />
          <span className="sr-only" id="currency-switcher-label">
            Display and pay in
          </span>
          <div
            className="flex min-w-0 flex-nowrap items-center gap-1"
            role="group"
            aria-labelledby="currency-switcher-label"
          >
            {CURRENCY_CODES.map((code: CurrencyCode) => {
              const active = code === currency;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => applyCurrency(code)}
                  aria-pressed={active}
                  title={CURRENCIES[code].label}
                  className={`px-2 py-1 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff] ${
                    active
                      ? "bg-[#e11d2e] text-black"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {CURRENCIES[code].symbol} {code}
                </button>
              );
            })}
          </div>
          {surcharge > 0 && (
            <span className="w-auto font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              incl. {surcharge}% processing
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Listbox-pattern currency picker used on narrow/mobile layouts. */
function CurrencyDropdown({
  currency,
  surcharge,
  compact = false,
}: {
  currency: CurrencyCode;
  surcharge: number;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, CURRENCY_CODES.indexOf(currency)),
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const labelId = useId();

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      if (refocus) triggerRef.current?.focus();
    },
    [],
  );

  const openList = useCallback(
    (index?: number) => {
      setActiveIndex(index ?? Math.max(0, CURRENCY_CODES.indexOf(currency)));
      setOpen(true);
    },
    [currency],
  );

  // Move DOM focus onto the active option so screen readers announce it.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex];
    el?.focus();
  }, [open, activeIndex]);

  // Close on outside pointer down, without stealing focus from what was clicked.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const select = (code: CurrencyCode) => {
    applyCurrency(code);
    close();
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    const last = CURRENCY_CODES.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i >= last ? 0 : i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? last : i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        select(CURRENCY_CODES[activeIndex]!);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        // Let focus leave naturally, but don't leave an orphaned open list.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openList(CURRENCY_CODES.length - 1);
    }
  };

  const active = CURRENCIES[currency];

  return (
    <div ref={wrapRef} className={compact ? "relative" : "w-full"}>
      <span id={labelId} className="sr-only">
        Display and pay in
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={labelId}
        aria-label={`Currency ${active.symbol} ${currency}`}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onTriggerKeyDown}
        className={
          compact
            ? "inline-flex h-9 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/80 px-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-200 transition-colors hover:border-zinc-700 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d2e]"
            : "flex min-h-11 w-full items-center gap-2 border border-border bg-background/40 px-3 py-2 text-start backdrop-blur-sm transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
        }
      >
        <Globe className={compact ? "size-3.5 shrink-0 text-[#e11d2e]" : "size-4 shrink-0 text-[#e11d2e]"} aria-hidden="true" />
        <span className={compact ? "tabular-nums" : "min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.18em] text-foreground"}>
          {active.symbol} {currency}
          {!compact && surcharge > 0 && (
            <span className="text-muted-foreground"> · incl. {surcharge}% processing</span>
          )}
        </span>
        <ChevronDown
          size={compact ? 12 : 16}
          aria-hidden="true"
          className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-labelledby={labelId}
          aria-activedescendant={`${listId}-${CURRENCY_CODES[activeIndex]}`}
          onKeyDown={onListKeyDown}
          className={
            compact
              ? "absolute end-0 z-[60] mt-1 max-h-[min(18rem,50vh)] w-[min(14rem,calc(100vw-1.5rem))] overflow-y-auto border border-border bg-background/95 shadow-xl backdrop-blur-md"
              : "mt-px w-full border border-border bg-background/95 backdrop-blur-md"
          }
        >
          {CURRENCY_CODES.map((code: CurrencyCode, i) => {
            const selected = code === currency;
            return (
              <li
                key={code}
                id={`${listId}-${code}`}
                role="option"
                aria-selected={selected}
                tabIndex={i === activeIndex ? 0 : -1}
                onClick={() => select(code)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-[#4b8bff] ${
                  selected ? "bg-[#e11d2e] text-black" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Check
                  size={14}
                  aria-hidden="true"
                  className={`shrink-0 ${selected ? "opacity-100" : "opacity-0"}`}
                />
                <span className="min-w-0 flex-1 truncate">
                  {CURRENCIES[code].symbol} {code}
                </span>
                <span className="sr-only">{CURRENCIES[code].label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
