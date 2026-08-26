import { useEffect } from "react";
import { X, Info, Music, Sparkles, ArrowUpRight } from "lucide-react";
import { Link } from "@tanstack/react-router";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: () => void;
}

const STEPS = [
  {
    n: "01",
    icon: Music,
    title: "Hybrid Engine 1.0 Alpha",
    tag: "Live Now",
    body: "The only active production pipeline right now is the Hybrid Engine 1.0 Alpha. Buy Hybrid Tokens, write your concept and lyrics, and generate release-ready single tracks instantly.",
  },
  {
    n: "02",
    icon: Sparkles,
    title: "Co-Produce with the Hybrid AI",
    tag: "Built-in Assistant",
    body: "Stuck on lyrics or structure? Use the Executive Co-Producer to generate lyrics in English, Lithuanian, Nigerian Pidgin, Spanish, or bilingual blends — then drop them straight into the engine.",
  },
  {
    n: "03",
    icon: Info,
    title: "Full-Service Audio Production Is Retired",
    tag: "Not Available",
    body: "10-track album production and full-service audio production are not open for new submissions. Distribution-only packages and music-video production are still live, and the Hybrid Engine 1.0 Alpha handles single-track generation.",
  },
];

export function HowItWorksModal({ open, onClose, onSubmit }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="How It Works"
      className="fixed inset-0 z-[110] flex flex-col modal-panel-solid lg:ps-[var(--site-sidebar-width)]"
      onClick={onClose}
    >
      <div
        className="relative mx-auto flex h-full w-full max-w-3xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/60 bg-white/70 px-6 py-4 backdrop-blur-md sm:px-10">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              <span className="text-[#e11d2e]">/</span>{" "}
              <span className="text-white">How</span>{" "}
              <span className="text-[#4b8bff]">It Works</span>
            </div>
            <div className="mt-1 truncate font-display text-sm font-semibold sm:text-base">
              Engine Only — Project Submissions Paused
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-10 w-10 shrink-0 place-items-center border border-border text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-10 sm:px-10 sm:py-14">
          <header className="border-b border-border pb-10">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              <span className="text-[#e11d2e]">HYBRID</span>{" "}
              <span className="text-white">AI</span>{" "}
              <span className="text-[#4b8bff]">RECORDS LLC</span>
            </div>
            <h2 className="mt-4 font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl md:text-5xl">
              How It Works
            </h2>
            <p className="mt-4 font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
              Hybrid Engine 1.0 Alpha is live. Full-service projects are paused.
            </p>
          </header>

          <ol className="relative mt-10 space-y-6 border-s border-border/60 ps-6 sm:ps-8">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              return (
                <li key={s.n} className="relative">
                  <span
                    aria-hidden="true"
                    className="absolute -start-[34px] top-1 grid h-8 w-8 place-items-center border border-[#e11d2e] bg-ink font-mono text-[10px] font-semibold text-[#e11d2e] sm:-start-[42px] sm:h-10 sm:w-10 sm:text-xs"
                  >
                    {s.n}
                  </span>
                  <div className="border border-border bg-white/[0.02] p-6 transition-colors hover:border-[#e11d2e]/60 sm:p-8">
                    <div className="flex items-start gap-4">
                      <div className="grid h-11 w-11 shrink-0 place-items-center border border-border bg-ink text-[#e11d2e]">
                        <Icon size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#4b8bff]">
                          Step {i + 1} — {s.tag}
                        </div>
                        <h2 className="mt-2 font-display text-xl font-semibold leading-tight tracking-tight text-white sm:text-2xl">
                          {s.title}
                        </h2>
                      </div>
                    </div>
                    <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground sm:text-base sm:leading-[1.75]">
                      {s.body}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/engine"
              onClick={onClose}
              className="w-full inline-flex items-center justify-center gap-2 bg-[#e11d2e] px-8 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-[#c11824] sm:w-auto"
            >
              Open Hybrid Engine 1.0 Alpha <ArrowUpRight size={14} />
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="w-full border border-white px-8 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-black sm:w-auto"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
