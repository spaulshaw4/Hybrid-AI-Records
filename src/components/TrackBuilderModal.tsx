import { useEffect, useMemo, useState } from "react";
import { X, ArrowRight, ArrowLeft, Check } from "lucide-react";
import type { ServicePackage } from "@/lib/services";
import { VocalCallCard } from "@/components/VocalCallCard";
import {
  CALL_CAPTURE_OPTIONS,
  CALL_DIAL_CODES,
  callPhoneE164,
  normalizePhoneDigits,
  CALL_PRIVACY_NOTES,
  CALL_RETENTION_OPTIONS,
  CALL_TIMEZONES,
  CALL_WINDOWS,
  DELIVERABLE_OPTIONS,
  GENRES,
  MUSICAL_KEYS,
  TEMPO_FEELS,
  VOCAL_OPTIONS,
  type TrackBrief,
  briefIsReady,
  browserTimezone,
  callDateIsFuture,
  callMeetingLink,
  callReady,
  ensureCallRoom,
  deliverablesReady,
  needsVocalCall,
  phoneReady,
  directionReady,
  emptyBrief,
  isValidBpm,
  loadBrief,
  saveBrief,
  splitLines,
} from "@/lib/track-brief";


type Props = {
  open: boolean;
  pkg: ServicePackage | null;
  priceLabel: string;
  onClose: () => void;
  /** Brief finished — hand off to the payment sheet. */
  onReady: (brief: TrackBrief) => void;
};

type StepKey = "direction" | "sound" | "call" | "delivery";

const STEP_LABELS: Record<StepKey, string> = {
  direction: "Direction",
  sound: "Sound",
  call: "Vocal call",
  delivery: "Delivery",
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Guided "Build a track" flow.
 *
 * Step 1 captures genre and references, step 2 tempo/key/vocals, step 3 the
 * deliverable preferences. The brief autosaves per package and is handed to
 * checkout as structured order notes.
 */
export function TrackBuilderModal({ open, pkg, priceLabel, onClose, onReady }: Props) {
  const slug = pkg?.slug ?? "track";
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState<TrackBrief>(() => emptyBrief());
  const [subGenresText, setSubGenresText] = useState("");
  const [referencesText, setReferencesText] = useState("");
  const [bpmText, setBpmText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const saved = loadBrief(slug) ?? emptyBrief();
    setStep(0);
    setError(null);
    setBrief(saved);
    setSubGenresText(saved.subGenres.join(", "));
    setReferencesText(saved.references.join("\n"));
    setBpmText(saved.tempoBpm ? String(saved.tempoBpm) : "");
  }, [open, slug]);

  const subGenres = useMemo(() => splitLines(subGenresText), [subGenresText]);
  const references = useMemo(() => splitLines(referencesText), [referencesText]);

  // Keep the derived lists on the brief so autosave + handoff stay in sync.
  useEffect(() => {
    if (!open) return;
    const bpmRaw = bpmText.trim();
    const tempoBpm = bpmRaw === "" ? null : Number(bpmRaw);
    setBrief((b) => {
      const next: TrackBrief = { ...b, subGenres, references, tempoBpm };
      saveBrief(slug, next);
      return next;
    });
  }, [open, slug, subGenres, references, bpmText]);

  // Every live-session brief gets its own room as soon as it needs one.
  useEffect(() => {
    if (!open) return;
    setBrief((b) => (needsVocalCall(b) && !b.callRoom ? { ...b, callRoom: ensureCallRoom(b) } : b));
  }, [open, brief.vocals]);

  // The vocal-call step only appears when the artist books a live session.
  const steps: StepKey[] = [
    "direction",
    "sound",
    ...(needsVocalCall(brief) ? (["call"] as StepKey[]) : []),
    "delivery",
  ];
  const current = steps[Math.min(step, steps.length - 1)] ?? "delivery";

  if (!open || !pkg) return null;

  const set = (patch: Partial<TrackBrief>) => setBrief((b) => ({ ...b, ...patch }));

  const toggleDeliverable = (value: string) =>
    setBrief((b) => ({
      ...b,
      deliverables: b.deliverables.includes(value)
        ? b.deliverables.filter((d) => d !== value)
        : [...b.deliverables, value],
    }));

  const next = () => {
    if (current === "direction" && !directionReady(brief)) {
      setError("Add a working title and pick a genre so we know what to build.");
      return;
    }
    if (current === "sound" && !isValidBpm(brief.tempoBpm)) {
      setError("Tempo must be between 40 and 220 BPM, or leave it blank.");
      return;
    }
    if (current === "call") {
      if (!callReady(brief)) {
        setError(
          !phoneReady(brief)
            ? "Add your WhatsApp number (country code + 6–15 digits) so we can call you."
            : !brief.callRecordConsent
              ? "Tick the recording and retention agreement before you continue."
              : "Pick a date and a time window for your vocal call.",
        );
        return;
      }
      if (!callDateIsFuture(brief.callDate) || !callDateIsFuture(brief.callAltDate)) {
        setError("Vocal call dates must be today or later.");
        return;
      }
    }
    setError(null);
    setStep((s) => Math.min(s + 1, steps.length - 1));
  };

  const finish = () => {
    if (!briefIsReady(brief)) {
      setError(
        !deliverablesReady(brief)
          ? "Pick at least one deliverable format."
          : !callReady(brief)
            ? !brief.callRecordConsent
              ? "Tick the recording and retention agreement before you continue."
              : "Pick a date and a time window for your vocal call."
            : "Add a working title and pick a genre first.",
      );
      return;
    }
    saveBrief(slug, brief);
    onReady(brief);
  };

  const field =
    "w-full border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-[#4b8bff]";
  const labelCls = "text-xs uppercase tracking-widest text-muted-foreground";
  const checkRow =
    "flex cursor-pointer items-center gap-3 border border-border bg-background/40 px-3 py-2 text-sm text-white/90 hover:border-border-strong";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Build a track — ${pkg.title}`}
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto overlay-scrim bg-black/80 p-4 backdrop-blur-md sm:p-8 lg:ps-[var(--site-sidebar-width)]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative my-auto w-full max-w-2xl border border-white/10 modal-panel-solid p-6 shadow-2xl sm:p-8"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close track builder"
          className="absolute end-3 top-3 rounded-full studio-glass p-2 text-foreground hover:bg-white"
        >
          <X size={16} aria-hidden />
        </button>

        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          {pkg.title} — single track · {priceLabel}
        </p>
        <h2 className="mt-2 font-display text-2xl font-semibold text-white">Build your track</h2>

        <ol className="mt-5 flex items-center gap-2" aria-label="Track builder steps">
          {steps.map((s, i) => (
            <li key={s} className="flex flex-1 items-center gap-2">
              <span
                aria-current={i === step ? "step" : undefined}
                className={`flex w-full items-center justify-center gap-2 border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] ${
                  i === step
                    ? "border-[#e11d2e] bg-[#e11d2e]/15 text-white"
                    : i < step
                      ? "border-border-strong text-white/70"
                      : "border-border text-muted-foreground"
                }`}
              >
                {i < step ? <Check size={11} aria-hidden /> : null}
                {i + 1}. {STEP_LABELS[s]}
              </span>
            </li>
          ))}
        </ol>

        {/* Step 1 — direction */}
        {current === "direction" && (
          <div className="mt-6 space-y-4">
            <div>
              <label className={labelCls} htmlFor="tb-title">Working title</label>
              <input
                id="tb-title"
                className={field}
                maxLength={120}
                value={brief.workingTitle}
                onChange={(e) => set({ workingTitle: e.target.value })}
                placeholder="e.g. Ashes & Neon"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="tb-genre">Genre</label>
                <select
                  id="tb-genre"
                  className={field}
                  value={brief.genre}
                  onChange={(e) => set({ genre: e.target.value })}
                >
                  <option value="">Select a genre…</option>
                  {GENRES.map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="tb-sub">Sub-genres / flavours</label>
                <input
                  id="tb-sub"
                  className={field}
                  maxLength={200}
                  value={subGenresText}
                  onChange={(e) => setSubGenresText(e.target.value)}
                  placeholder="drill, soul sample, spanish guitar"
                />
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="tb-refs">Reference tracks or artists</label>
              <textarea
                id="tb-refs"
                className={`${field} min-h-24`}
                maxLength={800}
                value={referencesText}
                onChange={(e) => setReferencesText(e.target.value)}
                placeholder={"One per line\ne.g. Kendrick Lamar — Money Trees"}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {references.length} reference{references.length === 1 ? "" : "s"} added
                {subGenres.length ? ` · ${subGenres.length} sub-genre${subGenres.length === 1 ? "" : "s"}` : ""}
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="tb-mood">Mood</label>
                <input
                  id="tb-mood"
                  className={field}
                  maxLength={120}
                  value={brief.mood}
                  onChange={(e) => set({ mood: e.target.value })}
                  placeholder="Dark, cinematic, defiant"
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="tb-lang">Language</label>
                <input
                  id="tb-lang"
                  className={field}
                  maxLength={60}
                  value={brief.language}
                  onChange={(e) => set({ language: e.target.value })}
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 2 — sound */}
        {current === "sound" && (
          <div className="mt-6 space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls} htmlFor="tb-bpm">Tempo (BPM)</label>
                <input
                  id="tb-bpm"
                  className={field}
                  inputMode="numeric"
                  value={bpmText}
                  onChange={(e) => setBpmText(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                  placeholder="Optional"
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="tb-feel">Tempo feel</label>
                <select
                  id="tb-feel"
                  className={field}
                  value={brief.tempoFeel}
                  onChange={(e) => set({ tempoFeel: e.target.value })}
                >
                  {TEMPO_FEELS.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="tb-key">Key</label>
                <select
                  id="tb-key"
                  className={field}
                  value={brief.key}
                  onChange={(e) => set({ key: e.target.value })}
                >
                  {MUSICAL_KEYS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="tb-vocals">Vocals</label>
              <select
                id="tb-vocals"
                className={field}
                value={brief.vocals}
                onChange={(e) => set({ vocals: e.target.value })}
              >
                {VOCAL_OPTIONS.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                You can&apos;t record and send your own vocals — we capture them with you on a live
                WhatsApp video call, and vocal sessions are English only.
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="tb-notes">Anything else the producer should know</label>
              <textarea
                id="tb-notes"
                className={`${field} min-h-24`}
                maxLength={1000}
                value={brief.notes}
                onChange={(e) => set({ notes: e.target.value })}
                placeholder="Structure, features, instruments to avoid…"
              />
            </div>
          </div>
        )}

        {/* Vocal call — pick a time window for the live video-chat session */}
        {current === "call" && (
          <div className="mt-6 space-y-4">
            <p className="text-sm text-white/80">
              Vocals are recorded with you on a live WhatsApp video call (English only). Pick the window
              that works best and we&apos;ll confirm the exact start time by email.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="tb-call-date">Preferred date</label>
                <input
                  id="tb-call-date"
                  type="date"
                  className={field}
                  min={todayISO()}
                  value={brief.callDate}
                  onChange={(e) => set({ callDate: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="tb-call-alt">Backup date (optional)</label>
                <input
                  id="tb-call-alt"
                  type="date"
                  className={field}
                  min={todayISO()}
                  value={brief.callAltDate}
                  onChange={(e) => set({ callAltDate: e.target.value })}
                />
              </div>
            </div>
            <div>
              <p className={labelCls}>Time window</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {CALL_WINDOWS.map((w) => (
                  <label key={w} className={checkRow}>
                    <input
                      type="radio"
                      name="tb-call-window"
                      checked={brief.callWindow === w}
                      onChange={() => set({ callWindow: w })}
                    />
                    {w}
                  </label>
                ))}
              </div>
            </div>
            {callMeetingLink(brief) && (
              <VocalCallCard
                meetingLink={callMeetingLink(brief)}
                date={brief.callDate}
                altDate={brief.callAltDate}
                window={brief.callWindow}
                timezone={brief.callTimezone}
                title="Your WhatsApp vocal call"
              />
            )}

            <div>
              <label className={labelCls} htmlFor="tb-call-tz">Your timezone</label>
              <select
                id="tb-call-tz"
                className={field}
                value={brief.callTimezone}
                onChange={(e) => set({ callTimezone: e.target.value })}
              >
                {Array.from(new Set([browserTimezone(), ...CALL_TIMEZONES])).map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Windows are shown in your local time. Sessions run about 60–90 minutes.
              </p>
            </div>

            {/* WhatsApp number for the call */}
            <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr]">
              <div>
                <label className={labelCls} htmlFor="tb-call-cc">Country code</label>
                <select
                  id="tb-call-cc"
                  className={field}
                  value={brief.callPhoneCountry}
                  onChange={(e) => set({ callPhoneCountry: e.target.value })}
                >
                  {CALL_DIAL_CODES.map((c) => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="tb-call-phone">WhatsApp number</label>
                <input
                  id="tb-call-phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  className={field}
                  value={brief.callPhoneNumber}
                  onChange={(e) => set({ callPhoneNumber: normalizePhoneDigits(e.target.value) })}
                  placeholder="6184793630"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {callPhoneE164(brief)
                    ? `We'll call you on ${callPhoneE164(brief)} — digits only, no spaces.`
                    : "Digits only, without the leading zero. This is the number we video call."}
                </p>
              </div>
            </div>



            {/* Privacy & recording controls */}
            <div className="space-y-4 border border-border bg-ink/40 p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Privacy &amp; recording
              </p>

              <div>
                <label className={labelCls} htmlFor="tb-capture">What we capture</label>
                <select
                  id="tb-capture"
                  className={field}
                  value={brief.callCapture}
                  onChange={(e) => set({ callCapture: e.target.value })}
                >
                  {CALL_CAPTURE_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className={labelCls} htmlFor="tb-retention">How long we keep raw takes</label>
                <select
                  id="tb-retention"
                  className={field}
                  value={brief.callRetention}
                  onChange={(e) => set({ callRetention: e.target.value })}
                >
                  {CALL_RETENTION_OPTIONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <ul className="list-disc space-y-1 ps-5 text-xs text-white/75">
                {CALL_PRIVACY_NOTES.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>

              <div className="grid gap-2">
                <label className={checkRow}>
                  <input
                    type="checkbox"
                    checked={brief.callPromoConsent}
                    onChange={(e) => set({ callPromoConsent: e.target.checked })}
                  />
                  Optional — you may use clips of this session in promo content
                </label>
                <label className={checkRow}>
                  <input
                    type="checkbox"
                    checked={brief.callGuestsAllowed}
                    onChange={(e) => set({ callGuestsAllowed: e.target.checked })}
                  />
                  Optional — extra team members may join the call (otherwise producer only)
                </label>
                <label className={checkRow}>
                  <input
                    type="checkbox"
                    checked={brief.callRecordConsent}
                    onChange={(e) => set({ callRecordConsent: e.target.checked })}
                  />
                  Required — I agree to the recording and retention settings above
                </label>
              </div>
            </div>

          </div>
        )}

        {/* Step 3 — delivery */}
        {current === "delivery" && (
          <div className="mt-6 space-y-4">
            <div>
              <p className={labelCls}>Deliverable formats</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {DELIVERABLE_OPTIONS.map((d) => (
                  <label key={d} className={checkRow}>
                    <input
                      type="checkbox"
                      checked={brief.deliverables.includes(d)}
                      onChange={() => toggleDeliverable(d)}
                    />
                    {d}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className={checkRow}>
                <input type="checkbox" checked={brief.stems} onChange={(e) => set({ stems: e.target.checked })} />
                Track stems
              </label>
              <label className={checkRow}>
                <input type="checkbox" checked={brief.radioEdit} onChange={(e) => set({ radioEdit: e.target.checked })} />
                Radio edit
              </label>
              <label className={checkRow}>
                <input type="checkbox" checked={brief.instrumental} onChange={(e) => set({ instrumental: e.target.checked })} />
                Instrumental
              </label>
            </div>

            <div className="border border-border bg-ink/40 p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Review</p>
              <dl className="mt-2 space-y-1 text-sm text-white/85">
                <div><span className="text-muted-foreground">Title: </span>{brief.workingTitle || "—"}</div>
                <div><span className="text-muted-foreground">Genre: </span>{[brief.genre, ...subGenres].filter(Boolean).join(" · ") || "—"}</div>
                <div><span className="text-muted-foreground">Tempo: </span>{brief.tempoBpm ? `${brief.tempoBpm} BPM · ` : ""}{brief.tempoFeel} · {brief.key}</div>
                <div><span className="text-muted-foreground">Vocals: </span>{brief.vocals}</div>
                {needsVocalCall(brief) && (
                  <div>
                    <span className="text-muted-foreground">WhatsApp: </span>
                    {callPhoneE164(brief) || "—"}
                  </div>
                )}
                {needsVocalCall(brief) && (
                  <div>
                    <span className="text-muted-foreground">Recording: </span>
                    {brief.callCapture} · {brief.callRetention} · promo use{" "}
                    {brief.callPromoConsent ? "allowed" : "not allowed"}
                  </div>
                )}
                {needsVocalCall(brief) && (
                  <div>
                    <span className="text-muted-foreground">Vocal call: </span>
                    {brief.callDate
                      ? `${brief.callDate} · ${brief.callWindow} (${brief.callTimezone})`
                      : "—"}
                  </div>
                )}
                <div><span className="text-muted-foreground">References: </span>{references.length ? references.join(", ") : "—"}</div>
              </dl>
            </div>

            {needsVocalCall(brief) && callMeetingLink(brief) && (
              <VocalCallCard
                meetingLink={callMeetingLink(brief)}
                date={brief.callDate}
                altDate={brief.callAltDate}
                window={brief.callWindow}
                timezone={brief.callTimezone}
              />
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 border border-[#e11d2e]/50 bg-[#e11d2e]/10 px-3 py-2 text-sm text-white">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))}
            className="flex items-center gap-2 border border-border px-4 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-white/80 hover:border-border-strong"
          >
            <ArrowLeft size={13} aria-hidden />
            {step === 0 ? "Cancel" : "Back"}
          </button>

          {step < steps.length - 1 ? (
            <button
              type="button"
              onClick={next}
              className="flex items-center gap-2 bg-[#e11d2e] px-5 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white hover:bg-[#c4162a]"
            >
              Next
              <ArrowRight size={13} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={finish}
              className="flex items-center gap-2 bg-[#e11d2e] px-5 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white hover:bg-[#c4162a]"
            >
              Continue to checkout — {priceLabel}
              <ArrowRight size={13} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
