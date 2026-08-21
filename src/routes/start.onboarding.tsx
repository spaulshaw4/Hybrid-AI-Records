import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, Sparkles } from "lucide-react";
import { SERVICES } from "@/lib/services";
import { useCurrency } from "@/lib/currency";
import { useMoneyFormat } from "@/lib/money-format";
import { CurrencySwitcher } from "@/components/CurrencySwitcher";
import { FlowProgress, type FlowStep } from "@/components/FlowProgress";
import { Wordmark } from "@/components/Wordmark";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

/** Shared with the package application page via localStorage. */
export const ONBOARDING_BRIEF_KEY = "hybrid.onboarding.brief.v1";

const GENRES = [
  "Hip-Hop / Rap",
  "R&B / Soul",
  "Afrobeats",
  "Rock / Metal",
  "Pop",
  "Country",
  "Electronic / EDM",
  "Gospel / Worship",
  "Other",
] as const;

const TIMELINES = [
  { id: "standard", label: "Standard", hint: "5–7 business days after intake" },
  { id: "scheduled", label: "Scheduled release", hint: "I have a target release date" },
  { id: "flexible", label: "Flexible", hint: "No rush — quality over speed" },
] as const;

type Brief = {
  tier: string;
  mode: "single" | "bundle";
  genre: string;
  genreOther: string;
  references: string;
  referenceLinks: string;
  timeline: string;
  targetDate: string;
  savedAt: number;
};

const EMPTY: Brief = {
  tier: SERVICES[0]!.slug,
  mode: "single",
  genre: "",
  genreOther: "",
  references: "",
  referenceLinks: "",
  timeline: "standard",
  targetDate: "",
  savedAt: 0,
};

const STEPS: FlowStep[] = [
  { id: "tier", label: "Budget tier", hint: "Pick your package" },
  { id: "genre", label: "Genre", hint: "What we're making" },
  { id: "references", label: "References", hint: "Sound targets" },
  { id: "timeline", label: "Timeline", hint: "When you need it" },
  { id: "review", label: "Review", hint: "Confirm & continue" },
];

export const Route = createFileRoute("/start/onboarding")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/start/onboarding",
      title: "Guided Intake — Start a Track | Hybrid AI Records",
      description: "A short guided intake: choose your budget tier, genre, reference tracks, and delivery timeline before you apply for a Hybrid AI Records release.",
      socialTitle: "Guided Intake — Start a Track | Hybrid AI Records",
      socialDescription: "Four quick steps — budget tier, genre, references, delivery timeline — then straight into your application.",
      type: "website",
      card: "summary_large_image",
    }),
  component: OnboardingPage,
});

function OnboardingPage() {
  const currency = useCurrency();
  const { label: priceLabel } = useMoneyFormat();
  const [brief, setBrief] = useState<Brief>(EMPTY);
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const restored = useRef(false);

  // Restore an in-progress brief after hydration so a refresh never restarts it.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const raw = window.localStorage.getItem(ONBOARDING_BRIEF_KEY);
      if (raw) setBrief({ ...EMPTY, ...(JSON.parse(raw) as Partial<Brief>) });
    } catch {
      /* ignore malformed storage */
    }
  }, []);

  // Autosave every answer.
  useEffect(() => {
    if (!restored.current || brief === EMPTY) return;
    try {
      window.localStorage.setItem(
        ONBOARDING_BRIEF_KEY,
        JSON.stringify({ ...brief, savedAt: Date.now() }),
      );
    } catch {
      /* storage unavailable — the flow still works in-memory */
    }
  }, [brief]);

  const set = <K extends keyof Brief>(key: K, value: Brief[K]) =>
    setBrief((prev) => ({ ...prev, [key]: value }));

  const pkg = SERVICES.find((s) => s.slug === brief.tier) ?? SERVICES[0]!;
  const genreLabel = brief.genre === "Other" ? brief.genreOther.trim() : brief.genre;
  const timeline = TIMELINES.find((t) => t.id === brief.timeline) ?? TIMELINES[0];

  const blockedReason =
    step === 1 && !genreLabel
      ? "Choose a genre (or type one in) to continue."
      : step === 2 && brief.references.trim().length < 3
        ? "Add at least one reference artist or track to continue."
        : step === 3 && brief.timeline === "scheduled" && !brief.targetDate
          ? "Add your target release date to continue."
          : undefined;

  const canAdvance = !blockedReason;

  // Final-action gate: the review CTAs stay locked until every required answer
  // is present, so no incomplete brief can be carried into the application.
  const briefGaps = [
    genreLabel ? null : "a genre",
    brief.references.trim().length >= 3 ? null : "at least one reference",
    brief.timeline === "scheduled" && !brief.targetDate ? "a target release date" : null,
  ].filter(Boolean) as string[];
  const briefComplete = briefGaps.length === 0;
  const priceFor = (slug: string) => {
    const s = SERVICES.find((x) => x.slug === slug)!;
    return priceLabel(s.priceIdSingle, currency) ?? s.priceSingle;
  };

  const summary = [
    `Package: ${pkg.title} (single track) — ${priceFor(pkg.slug)}`,
    `Genre: ${genreLabel || "—"}`,
    `References: ${brief.references.trim() || "—"}`,
    brief.referenceLinks.trim() ? `Reference links: ${brief.referenceLinks.trim()}` : null,
    `Timeline: ${timeline!.label}${brief.targetDate ? ` — target ${brief.targetDate}` : ""} (${timeline!.hint})`,
  ]
    .filter(Boolean)
    .join("\n");

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-50 border-b border-border bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link to="/" aria-label="Hybrid AI Records home">
            <Wordmark />
          </Link>
          <Link
            to="/start"
            className="text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary"
          >
            ← All packages
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-12 md:py-16">
        <div className="eyebrow">
          <span className="text-[#e11d2e]">/ Guided</span> <span className="text-white">intake</span>
        </div>
        <h1 className="mt-4 max-w-3xl font-display text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
          <span className="text-white">Four quick answers.</span>{" "}
          <span className="text-[#4b8bff]">Then we build.</span>
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          Budget tier, genre, references, and delivery timeline. Your answers save automatically and
          carry into your application.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <CurrencySwitcher />
        </div>

        <FlowProgress
          steps={STEPS}
          current={step}
          blockedReason={blockedReason}
          onStepSelect={(i) => setStep(Math.min(i, step))}
          className="mt-8"
        />

        <section className="mt-6 border border-border bg-background/35 p-6 backdrop-blur-sm md:p-8">
          {step === 0 && (
            <fieldset>
              <legend className="font-display text-xl font-semibold text-white">
                What&rsquo;s your budget tier?
              </legend>
              <p className="mt-1 text-xs text-muted-foreground">
                Fixed pricing, no backend royalty cuts. You can change this later.
              </p>

              <div className="mt-5 grid gap-px bg-border/60 md:grid-cols-3">
                {SERVICES.map((s) => {
                  const on = brief.tier === s.slug;
                  return (
                    <button
                      key={s.slug}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set("tier", s.slug)}
                      className={`flex flex-col gap-2 p-5 text-start transition-colors ${
                        on ? "bg-[#e11d2e]/12" : "bg-background/40 hover:bg-background/70"
                      }`}
                    >
                      <span className="font-mono text-xs" style={{ color: s.color }}>
                        / {s.n}
                      </span>
                      <span className="font-display text-lg font-semibold" style={{ color: s.color }}>
                        {s.title}
                      </span>
                      <span className="font-display text-2xl font-bold tabular-nums text-white">
                        {priceFor(s.slug)}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">{s.outcome}</span>
                      {on && (
                        <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-widest text-[#e11d2e]">
                          <Check size={13} aria-hidden /> Selected
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          {step === 1 && (
            <fieldset>
              <legend className="font-display text-xl font-semibold text-white">
                What genre are we making?
              </legend>
              <p className="mt-1 text-xs text-muted-foreground">
                This sets the production lane, mix targets, and mastering loudness.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {GENRES.map((g) => {
                  const on = brief.genre === g;
                  return (
                    <button
                      key={g}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set("genre", g)}
                      className={`border px-4 py-2 text-sm font-medium transition-colors ${
                        on
                          ? "border-[#e11d2e] bg-[#e11d2e]/15 text-white"
                          : "border-border text-white/70 hover:border-white/50 hover:text-white"
                      }`}
                    >
                      {g}
                    </button>
                  );
                })}
              </div>
              {brief.genre === "Other" && (
                <div className="mt-4">
                  <label htmlFor="ob-genre-other" className="text-xs font-medium text-white">
                    Tell us the genre
                  </label>
                  <input
                    id="ob-genre-other"
                    value={brief.genreOther}
                    maxLength={60}
                    onChange={(e) => set("genreOther", e.target.value)}
                    placeholder="e.g. Drill / Amapiano fusion"
                    className="mt-1 w-full max-w-md border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-[#e11d2e]"
                  />
                </div>
              )}
            </fieldset>
          )}

          {step === 2 && (
            <fieldset>
              <legend className="font-display text-xl font-semibold text-white">
                Which references should we chase?
              </legend>
              <p className="mt-1 text-xs text-muted-foreground">
                Name 2–3 artists or songs that sound like the record you want.
              </p>
              <div className="mt-5 grid gap-4">
                <div>
                  <label htmlFor="ob-refs" className="text-xs font-medium text-white">
                    Reference artists or tracks <span className="text-[#e11d2e]">*</span>
                  </label>
                  <textarea
                    id="ob-refs"
                    rows={4}
                    maxLength={600}
                    value={brief.references}
                    onChange={(e) => set("references", e.target.value)}
                    placeholder="e.g. Bring Me The Horizon — Kool-Aid, Sleep Token, Nine Inch Nails drums"
                    className="mt-1 w-full resize-y border border-border bg-background/60 px-3 py-2 text-sm leading-relaxed text-white outline-none focus:border-[#e11d2e]"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {brief.references.trim().length}/600 characters
                  </p>
                </div>
                <div>
                  <label htmlFor="ob-ref-links" className="text-xs font-medium text-white">
                    Links (optional)
                  </label>
                  <textarea
                    id="ob-ref-links"
                    rows={2}
                    maxLength={600}
                    value={brief.referenceLinks}
                    onChange={(e) => set("referenceLinks", e.target.value)}
                    placeholder="Spotify, YouTube, or Drive links — one per line"
                    className="mt-1 w-full resize-y border border-border bg-background/60 px-3 py-2 text-sm leading-relaxed text-white outline-none focus:border-[#4b8bff]"
                  />
                </div>
              </div>
            </fieldset>
          )}

          {step === 3 && (
            <fieldset>
              <legend className="font-display text-xl font-semibold text-white">
                When do you need it delivered?
              </legend>
              <p className="mt-1 text-xs text-muted-foreground">
                Standard turnaround is 5–7 business days after your intake is approved.
              </p>
              <div className="mt-5 grid gap-px bg-border/60 md:grid-cols-3">
                {TIMELINES.map((t) => {
                  const on = brief.timeline === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set("timeline", t.id)}
                      className={`p-5 text-start transition-colors ${
                        on ? "bg-[#4b8bff]/12" : "bg-background/40 hover:bg-background/70"
                      }`}
                    >
                      <span className="font-display text-lg font-semibold text-white">{t.label}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{t.hint}</span>
                    </button>
                  );
                })}
              </div>
              {brief.timeline === "scheduled" && (
                <div className="mt-4">
                  <label htmlFor="ob-date" className="text-xs font-medium text-white">
                    Target release date <span className="text-[#e11d2e]">*</span>
                  </label>
                  <input
                    id="ob-date"
                    type="date"
                    value={brief.targetDate}
                    onChange={(e) => set("targetDate", e.target.value)}
                    className="mt-1 block border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-[#4b8bff]"
                  />
                </div>
              )}
            </fieldset>
          )}

          {step === 4 && (
            <div>
              <h2 className="font-display text-xl font-semibold text-white">Review your brief</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Check it over — then continue into the application with this tier preselected.
              </p>

              <dl className="mt-5 grid gap-4 sm:grid-cols-2">
                <ReviewRow label="Budget tier" value={`${pkg.title} — ${priceFor(pkg.slug)}`} onEdit={() => setStep(0)} />
                <ReviewRow label="Genre" value={genreLabel || "—"} onEdit={() => setStep(1)} />
                <ReviewRow
                  label="Delivery timeline"
                  value={`${timeline!.label}${brief.targetDate ? ` — ${brief.targetDate}` : ""}`}
                  onEdit={() => setStep(3)}
                />
                <div className="sm:col-span-2">
                  <ReviewRow
                    label="References"
                    value={brief.references.trim() || "—"}
                    extra={brief.referenceLinks.trim()}
                    onEdit={() => setStep(2)}
                  />
                </div>
              </dl>

              <div className="mt-6 flex flex-wrap gap-3">
                {briefComplete ? (
                  <Link
                    to="/start/$package"
                    params={{ package: pkg.slug }}
                    search={{ mode: "single" as const, step: "track-details" }}
                    className="inline-flex items-center gap-2 bg-[#e11d2e] px-6 py-3 text-sm font-semibold uppercase tracking-widest text-white transition-all hover:bg-[#c81828]"
                  >
                    <Sparkles size={16} aria-hidden />
                    Continue to application
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled
                    aria-describedby="ob-brief-gate"
                    className="inline-flex cursor-not-allowed items-center gap-2 bg-[#e11d2e] px-6 py-3 text-sm font-semibold uppercase tracking-widest text-white opacity-50"
                  >
                    <Sparkles size={16} aria-hidden />
                    Continue to application
                  </button>
                )}
                <button
                  type="button"
                  onClick={copySummary}
                  disabled={!briefComplete}
                  aria-describedby={briefComplete ? undefined : "ob-brief-gate"}
                  className="inline-flex items-center gap-2 border border-border-strong px-6 py-3 text-sm font-semibold uppercase tracking-widest text-white transition-colors hover:border-[#4b8bff] hover:text-[#4b8bff] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border-strong disabled:hover:text-white"
                >
                  {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
                  {copied ? "Copied" : "Copy brief"}
                </button>
              </div>
              {!briefComplete && (
                <p id="ob-brief-gate" role="status" className="mt-3 text-xs text-[#e11d2e]">
                  Add {briefGaps.join(", ")} before continuing — use the Edit links above.
                </p>
              )}
            </div>
          )}

          {step < 4 && (
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0}
                className="inline-flex items-center gap-2 border border-border px-5 py-3 text-sm font-semibold uppercase tracking-widest text-white transition-colors hover:border-white/60 disabled:opacity-40"
              >
                <ArrowLeft size={15} aria-hidden />
                Back
              </button>
              <div className="flex items-center gap-3">
                {blockedReason && (
                  <span className="text-xs text-[#e11d2e]">{blockedReason}</span>
                )}
                <button
                  type="button"
                  onClick={() => canAdvance && setStep((s) => Math.min(STEPS.length - 1, s + 1))}
                  disabled={!canAdvance}
                  className="inline-flex items-center gap-2 bg-[#e11d2e] px-6 py-3 text-sm font-semibold uppercase tracking-widest text-white transition-all hover:bg-[#c81828] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next step
                  <ArrowRight size={15} aria-hidden />
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function ReviewRow({
  label,
  value,
  extra,
  onEdit,
}: {
  label: string;
  value: string;
  extra?: string;
  onEdit: () => void;
}) {
  return (
    <div className="border border-border bg-background/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <dt className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </dt>
        <button
          type="button"
          onClick={onEdit}
          className="text-[11px] font-semibold uppercase tracking-widest text-[#4b8bff] underline-offset-4 hover:underline"
        >
          Edit
        </button>
      </div>
      <dd className="mt-1 whitespace-pre-line text-sm text-white">{value}</dd>
      {extra ? (
        <dd className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{extra}</dd>
      ) : null}
    </div>
  );
}
