import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Loader2, AlertTriangle, ChevronDown, Search } from "lucide-react";
import { toast } from "sonner";
import { LANGUAGES, languageInfo, setLanguage, useLanguageState, type LanguageCode } from "@/lib/i18n";
import { SettingsError, settingsErrorMessage } from "@/lib/settings-error";

/** Applies a language change, surfacing any failure as an error toast. */
function applyLanguage(code: LanguageCode) {
  try {
    setLanguage(code);
    const info = languageInfo(code);
    toast.success(`Language set to ${info.label} (${info.native})`);
  } catch (error) {
    const applied = error instanceof SettingsError && error.applied;
    toast.error(applied ? "Language not saved" : "Couldn't change language", {
      description: settingsErrorMessage(error),
    });
  }
}

type LanguageEntry = (typeof LANGUAGES)[number];

/** Case/accent-insensitive haystack so "portugues" also matches "Português". */
function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function matches(entry: LanguageEntry, query: string) {
  if (!query) return true;
  const q = normalize(query);
  return (
    normalize(entry.native).includes(q) ||
    normalize(entry.label).includes(q) ||
    normalize(entry.code).includes(q)
  );
}

/**
 * Site-wide language picker. English is the primary language; everything else
 * is translated on the fly and cached, so switching back is instant.
 *
 * Follows the ARIA combobox + listbox pattern: the trigger opens a panel whose
 * search box holds DOM focus and points at the active row with
 * aria-activedescendant, so typing filters the list while a screen reader still
 * announces each option as the user arrows through it.
 *
 *   Enter / Space / ArrowDown / ArrowUp — open (ArrowUp lands on the last item)
 *   type ............................... filter by native or English name
 *   ArrowUp / ArrowDown ................ move the active option
 *   Home / End ......................... first / last visible option
 *   Enter .............................. choose the active option
 *   Escape / Tab ....................... close and return focus to the trigger
 */
export function LanguageSwitcher({
  className = "",
  menuAlign = "start",
}: {
  className?: string;
  menuAlign?: "start" | "end";
}) {
  const { language, status, message } = useLanguageState();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const baseId = useId();
  const listId = `${baseId}-language-list`;
  const searchId = `${baseId}-language-search`;
  const optionId = (i: number) => `${baseId}-language-option-${i}`;
  const info = languageInfo(language);

  // Options currently shown, after the search filter.
  const visible = useMemo(() => LANGUAGES.filter((l) => matches(l, query)), [query]);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(
    (index: "selected" | "last") => {
      setQuery("");
      const selected = Math.max(
        0,
        LANGUAGES.findIndex((l) => l.code === language),
      );
      setActiveIndex(index === "last" ? LANGUAGES.length - 1 : selected);
      setOpen(true);
    },
    [language],
  );

  // Click outside closes without stealing focus back from wherever the user went.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Move real focus onto the search box when the panel opens.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Keep the active option inside the filtered range and scrolled into view.
  useEffect(() => {
    if (!open) return;
    if (activeIndex > visible.length - 1) setActiveIndex(visible.length ? visible.length - 1 : 0);
  }, [open, activeIndex, visible.length]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, visible.length]);

  const choose = (index: number) => {
    const next = visible[index];
    if (!next) {
      toast.error("Couldn't change language", {
        description: "That option is no longer available. Please pick another language.",
      });
    } else {
      applyLanguage(next.code as LanguageCode);
    }
    closeAndRestoreFocus();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu("selected");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openMenu("last");
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = visible.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i >= last ? 0 : i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? Math.max(last, 0) : i - 1));
        return;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        e.preventDefault();
        setActiveIndex(Math.max(last, 0));
        return;
      case "Enter":
        e.preventDefault();
        if (visible.length) choose(activeIndex);
        return;
      case "Escape":
        e.preventDefault();
        closeAndRestoreFocus();
        return;
      case "Tab":
        setOpen(false);
        return;
      default:
        break;
    }
  };

  return (
    <div ref={ref} className={`relative inline-block ${className}`} data-no-translate>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu("selected"))}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Choose language, current language ${info.label}`}
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background/40 px-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-foreground backdrop-blur-sm transition-colors hover:border-[#e11d2e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d2e] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {status === "translating" ? (
          <Loader2 className="size-3.5 animate-spin text-[#e11d2e]" aria-hidden="true" />
        ) : status === "error" ? (
          <AlertTriangle className="size-3.5 text-[#e11d2e]" aria-hidden="true" />
        ) : (
          <span className="text-sm leading-none" aria-hidden="true">{info.flag}</span>
        )}
        <span>{info.code}</span>
        <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
      </button>

      <span aria-live="polite" className="sr-only">
        {status === "translating"
          ? `Translating page into ${info.label}`
          : status === "error"
            ? message
            : ""}
      </span>

      {open && (
        <div className={`absolute z-[60] mt-1 flex w-[min(17rem,calc(100vw-3rem))] flex-col border border-border bg-background/95 shadow-xl backdrop-blur-md ${menuAlign === "end" ? "end-0" : "start-0"}`}>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={searchRef}
              id={searchId}
              type="text"
              role="combobox"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
              aria-label="Search languages"
              aria-controls={listId}
              aria-expanded
              aria-autocomplete="list"
              aria-activedescendant={visible.length ? optionId(activeIndex) : undefined}
              placeholder="Search languages…"
              className="w-full min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>

          <div
            id={listId}
            role="listbox"
            aria-label="Language"
            className="max-h-[min(18rem,45vh)] overflow-y-auto overscroll-contain py-1"
          >
            {visible.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                No language matches “{query}”.
              </p>
            ) : (
              visible.map((l, i) => {
                const active = l.code === language;
                const focused = i === activeIndex;
                return (
                  <div
                    key={l.code}
                    id={optionId(i)}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    role="option"
                    aria-selected={active}
                    onClick={() => choose(i)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-start text-xs transition-colors ${
                      active
                        ? "bg-[#e11d2e] text-black"
                        : focused
                          ? "bg-foreground/10 text-foreground"
                          : "text-foreground"
                    } ${focused && !active ? "ring-1 ring-inset ring-[#e11d2e]/60" : ""}`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2.5">
                      <span className="shrink-0 text-base leading-none" aria-hidden="true">{l.flag}</span>
                      <span className="flex min-w-0 flex-col">
                        <span className="break-words font-medium">{l.native}</span>
                        <span className={`break-words font-mono text-[10px] uppercase tracking-[0.14em] ${active ? "text-black/70" : "text-muted-foreground"}`}>
                          {l.code} · {l.label}
                          {l.code === "en" ? " · primary" : ""}
                        </span>
                      </span>
                    </span>

                    {active && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {status === "error" && (
        <p role="alert" className="absolute end-0 top-full mt-1 w-56 border border-[#e11d2e]/50 bg-background/95 px-2 py-1 text-[10px] text-[#e11d2e]">
          {message}
        </p>
      )}
    </div>
  );
}
