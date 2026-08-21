import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, Globe, Mail, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { ServicePackage } from "@/lib/services";
import {
  SlotAvailabilitySummary,
  findBusyWindow,
  wallTimeToInstant,
} from "@/components/SlotAvailabilitySummary";
import {
  getVocalSessionAvailability,
  type BusyWindow,
} from "@/lib/vocal-session-availability.functions";
import { CalendarExportLinks } from "@/components/CalendarExportLinks";
import { EmailPreviewModal } from "./EmailPreviewModal";
import { RescheduleHistory } from "@/components/RescheduleHistory";
import {
  notifyVocalSessionReceived,
  resendVocalSessionConfirmation,
} from "@/lib/vocal-session-notify.functions";

import {
  clearBooking,
  loadBooking,
  saveBooking,
  type BookingRound,
  type StoredBooking,
} from "@/lib/vocal-session-booking";
import {
  getVocalSessionStatus,
  type BookingStatus,
} from "@/lib/vocal-session-status.functions";

/** A small, curated timezone list plus whatever the browser reports. */
const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Vilnius",
  "Europe/Berlin",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

type Slot = { date: string; time: string };

const slotSchema = z.object({
  date: z.string().min(1, "Pick a date"),
  time: z.string().min(1, "Pick a time"),
});

const schema = z.object({
  artist: z.string().trim().min(1, "Artist name is required").max(120),
  email: z.string().trim().email("Enter a valid email").max(254),
  timezone: z.string().trim().min(1).max(64),
  notes: z.string().trim().max(1000).optional(),
  slots: z.array(slotSchema).min(1, "Add at least one time slot").max(5),
});

/**
 * Recording consent modes for the live vocal session. Audio-only is the
 * default: we capture the vocal take, never the video feed.
 */
const RECORDING_MODES = [
  {
    id: "audio-only",
    label: "Audio only (default)",
    summary: "We record your vocal audio for the track. Your video feed is never captured.",
  },
  {
    id: "audio-video",
    label: "Audio + video",
    summary: "We record both audio and video, so takes can be reused for visual content.",
  },
  {
    id: "none",
    label: "No recording",
    summary: "Nothing is recorded. The session is coaching/direction only and takes are re-cut later.",
  },
] as const;

type RecordingMode = (typeof RECORDING_MODES)[number]["id"];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}


/**
 * Scheduling flow for the "Vocals & Lyrics (English only)" intake path:
 * the artist proposes up to 3 video-chat slots and confirms their timezone.
 */
export function VocalSessionScheduler({
  pkg,
  className = "",
}: {
  pkg?: ServicePackage | null;
  className?: string;
}) {
  const browserZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const [artist, setArtist] = useState("");
  const [email, setEmail] = useState("");
  const [timezone, setTimezone] = useState(browserZone);
  const [notes, setNotes] = useState("");
  /** Recording consent — audio-only by default, must be acknowledged. */
  const [recordingMode, setRecordingMode] = useState<RecordingMode>("audio-only");
  const [recordingAck, setRecordingAck] = useState(false);

  const [slots, setSlots] = useState<Slot[]>([{ date: "", time: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  /**
   * The whole booking, kept across every reschedule round (and page reloads)
   * so no original detail, slot or confirmation is ever lost.
   */
  const [booking, setBooking] = useState<StoredBooking | null>(null);
  const [status, setStatus] = useState<BookingStatus | null>(null);
  /** True while the artist is editing new times for an existing booking. */
  const [rescheduling, setRescheduling] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendWait, setResendWait] = useState(0);

  // Tick the resend cooldown down so the button re-enables on its own.
  useEffect(() => {
    if (resendWait <= 0) return;
    const t = setTimeout(() => setResendWait((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendWait]);


  useEffect(() => setTimezone(browserZone), [browserZone]);

  // Restore an in-flight booking so a refresh never drops the original request.
  useEffect(() => {
    const saved = loadBooking();
    if (!saved) return;
    setBooking(saved);
    setArtist(saved.artist);
    setEmail(saved.email);
    setTimezone(saved.timezone);
    setNotes(saved.notes ?? "");
    setSlots(saved.rounds[saved.rounds.length - 1]?.slots ?? [{ date: "", time: "" }]);
    setSent(true);
  }, []);

  // Live confirmation status for the booking (survives further reschedules).
  useEffect(() => {
    if (!booking?.requestId) return;
    let active = true;
    getVocalSessionStatus({ data: { requestId: booking.requestId } })
      .then((res) => {
        if (active) setStatus(res);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [booking?.requestId, booking?.rounds.length]);

  // Live desk availability so the artist sees which hours are open before
  // sending (or re-sending) their times.
  const [windows, setWindows] = useState<BusyWindow[]>([]);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [availabilityTick, setAvailabilityTick] = useState(0);

  useEffect(() => {
    if (sent && !rescheduling) return;
    let active = true;
    setChecking(true);
    getVocalSessionAvailability({ data: { excludeRequestId: booking?.requestId || null } })
      .then((res) => {
        if (!active) return;
        setWindows(res.windows);
        setCheckedAt(res.checkedAt);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [sent, rescheduling, booking?.requestId, availabilityTick]);

  // Keep the hints fresh while the form is open.
  useEffect(() => {
    if (sent && !rescheduling) return;
    const id = window.setInterval(() => setAvailabilityTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [sent, rescheduling]);

  const slotHint = (slot: Slot) => {
    if (!slot.date || !slot.time) return null;
    const instant = wallTimeToInstant(slot.date, slot.time, timezone);
    if (!instant) return null;
    const busy = findBusyWindow(windows, instant);
    if (!busy) return { color: "#3fbf6a", text: "Open — nothing booked in this hour." };
    if (busy.kind === "confirmed")
      return { color: "#e11d2e", text: "Taken — a session is already confirmed here." };
    return {
      color: "#e2a13a",
      text: `In demand — ${busy.count} other request${busy.count === 1 ? "" : "s"} for this hour.`,
    };
  };

  const zoneOptions = useMemo(
    () => Array.from(new Set([browserZone, ...COMMON_TIMEZONES])),
    [browserZone],
  );

  const offsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);

  const rescheduleRound = booking ? booking.rounds.length - 1 : 0;

  const updateSlot = (i: number, patch: Partial<Slot>) =>
    setSlots((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const selectedRecording =
    RECORDING_MODES.find((m) => m.id === recordingMode) ?? RECORDING_MODES[0];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = schema.safeParse({
      artist,
      email,
      timezone,
      notes: notes || undefined,
      slots: slots.filter((s) => s.date && s.time),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please check the form.");
      return;
    }
    if (!recordingAck) {
      setError("Please acknowledge the recording mode before continuing.");
      return;
    }

    const nextRound = booking ? booking.rounds.length : 0;
    const previous = booking?.rounds[booking.rounds.length - 1]?.slots
      .map((s) => `${s.date} ${s.time}`)
      .join(", ");
    const rescheduleNote =
      nextRound > 0 && previous
        ? `Reschedule request #${nextRound} — please replace the previously proposed times (${previous}).`
        : null;
    const recordingNote = `Recording consent: ${selectedRecording.label} — ${selectedRecording.summary} (acknowledged by the artist).`;
    const combinedNotes =
      [rescheduleNote, recordingNote, parsed.data.notes].filter(Boolean).join("\n\n").slice(0, 1000) ||
      null;


    setBusy(true);
    const { data: inserted, error: dbError } = await supabase
      .from("vocal_session_requests")
      .insert({
      artist: parsed.data.artist,
      email: parsed.data.email,
      timezone: parsed.data.timezone,
      timezone_offset_minutes: offsetMinutes,
      package_slug: pkg?.slug ?? null,
      package_label: pkg?.title ?? null,
      notes: combinedNotes,
      slots: parsed.data.slots,
      reschedule_round: nextRound,
      // Every reschedule points back at the original booking, which keeps its
      // video-chat room and any confirmation already made.
      original_request_id: booking?.requestId ?? null,
      })
      .select("id")
      .single();
    setBusy(false);

    if (dbError) {
      setError("We couldn't send your times. Please try again or email us directly.");
      return;
    }

    const round: BookingRound = {
      round: nextRound,
      slots: parsed.data.slots,
      sentAt: new Date().toISOString(),
      requestId: inserted?.id ?? null,
    };
    const nextBooking: StoredBooking = booking
      ? { ...booking, notes: parsed.data.notes ?? null, rounds: [...booking.rounds, round] }
      : {
          requestId: inserted?.id ?? "",
          artist: parsed.data.artist,
          email: parsed.data.email,
          timezone: parsed.data.timezone,
          packageLabel: pkg?.title ?? null,
          notes: parsed.data.notes ?? null,
          bookedAt: round.sentAt,
          rounds: [round],
        };
    setBooking(nextBooking);
    saveBooking(nextBooking);
    setRescheduling(false);
    setSent(true);
    toast.success(nextRound > 0 ? "New times sent" : "Session times sent", {
      description:
        nextRound > 0
          ? "Your original booking details are kept — we'll confirm the updated slot."
          : "We'll confirm one of your slots by email.",
    });

    // Acknowledgement email is a notification, not part of the booking — a
    // failure here must never look like a lost request.
    if (inserted?.id) {
      void notifyVocalSessionReceived({ data: { requestId: inserted.id } }).catch(() => {});
    }

  };

  const startReschedule = () => {
    setRescheduling(true);
    setSent(false);
    setError(null);
    // Keep artist, email, timezone, notes and the previous slots pre-filled so
    // the artist edits times instead of re-entering the whole booking.
    const last = booking?.rounds[booking.rounds.length - 1]?.slots ?? [];
    setSlots(last.length ? last : [{ date: "", time: "" }]);
  };

  const startNewBooking = () => {
    clearBooking();
    setBooking(null);
    setStatus(null);
    setRescheduling(false);
    setSent(false);
    setNotes("");
    setRecordingMode("audio-only");
    setRecordingAck(false);

    setSlots([{ date: "", time: "" }]);
  };

  const resend = async () => {
    if (!booking?.requestId || resending || resendWait > 0) return;
    setResending(true);
    try {
      const res = (await resendVocalSessionConfirmation({
        data: { requestId: booking.requestId },
      })) as {
        ok: boolean;
        reason?: string;
        retryInSeconds?: number;
        recipient?: string;
        cooldownSeconds?: number;
      };
      if (res.ok) {
        setResendWait(res.cooldownSeconds ?? 60);
        toast.success(`Confirmation email resent to ${res.recipient ?? booking.email}`);
      } else if (res.reason === "cooldown") {
        setResendWait(res.retryInSeconds ?? 60);
        toast.info(`Already sent — try again in ${res.retryInSeconds ?? 60}s.`);
      } else {
        toast.error("We couldn't resend the email. Please contact us directly.");
      }
    } catch {
      toast.error("We couldn't resend the email. Please contact us directly.");
    } finally {
      setResending(false);
    }
  };


  if (sent && booking) {
    const latest = booking.rounds[booking.rounds.length - 1];
    const confirmed = status?.confirmedSlot;
    return (
      <div
        className={`border border-border-strong bg-background/40 p-6 backdrop-blur-sm ${className}`}
      >
        <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[#4b8bff]">
          <Check size={14} aria-hidden />{" "}
          {rescheduleRound > 0
            ? `New times sent · reschedule #${rescheduleRound}`
            : "Session request sent"}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-white/80">
          Thanks — we have your preferred times in{" "}
          <span className="text-white">{booking.timezone}</span>. We'll email{" "}
          <span className="text-white">{booking.email}</span> with a confirmed slot and the
          video-chat link.
        </p>

        <dl className="mt-5 grid grid-cols-1 gap-2 border border-border-strong/60 p-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="font-mono uppercase tracking-[0.16em] text-muted-foreground">Artist</dt>
            <dd className="text-white/85">{booking.artist}</dd>
          </div>
          <div>
            <dt className="font-mono uppercase tracking-[0.16em] text-muted-foreground">
              Original booking
            </dt>
            <dd className="text-white/85">{new Date(booking.bookedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="font-mono uppercase tracking-[0.16em] text-muted-foreground">Package</dt>
            <dd className="text-white/85">{booking.packageLabel ?? "Vocals & Lyrics"}</dd>
          </div>
          <div>
            <dt className="font-mono uppercase tracking-[0.16em] text-muted-foreground">
              Confirmation status
            </dt>
            <dd className="text-white/85">
              {confirmed?.date && confirmed?.time
                ? `Confirmed · ${confirmed.date} ${confirmed.time}`
                : (status?.status ?? "awaiting confirmation")}
            </dd>
          </div>
        </dl>

        {confirmed?.date && (
          <p className="mt-3 text-xs leading-relaxed text-white/70">
            Your confirmed slot stays booked while a reschedule is reviewed — we only move it once
            we approve a new time.
          </p>
        )}

        {latest && latest.slots.length > 0 && (
          <ul className="mt-4 space-y-4 font-mono text-xs text-white/70">
            {latest.slots.map((s, i) => (
              <li key={`${s.date}-${s.time}-${i}`}>
                {s.date} · {s.time}
                <CalendarExportLinks
                  artist={booking.artist}
                  slot={s}
                  timezone={booking.timezone}
                  packageLabel={booking.packageLabel}
                  className="mt-2"
                />
              </li>
            ))}
          </ul>
        )}

        {booking.rounds.length > 1 && (
          <RescheduleHistory
            rounds={booking.rounds.slice(0, -1)}
            currentSlots={latest?.slots ?? []}
            timezone={booking.timezone}
            confirmedSlot={confirmed}
            className="mt-5"
          />
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={startReschedule}
            className="inline-flex items-center gap-2 border border-border-strong px-5 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:border-[#e11d2e] hover:text-[#e11d2e]"
          >
            <RefreshCcw size={13} aria-hidden /> Request different times
          </button>
          <EmailPreviewModal
            artist={booking.artist}
            email={booking.email}
            timezone={booking.timezone}
            packageLabel={booking.packageLabel}
            slots={latest?.slots ?? []}
            rescheduleRound={rescheduleRound}
            currentStatus={status?.status ?? null}
            confirmedSlot={confirmed?.date && confirmed?.time ? { date: confirmed.date, time: confirmed.time } : null}
          />
          <button
            type="button"
            onClick={resend}
            disabled={resending || resendWait > 0}
            className="inline-flex items-center gap-2 border border-border-strong px-5 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:border-[#4b8bff] hover:text-[#4b8bff] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Mail size={13} aria-hidden />{" "}
            {resending
              ? "Resending…"
              : resendWait > 0
                ? `Resend in ${resendWait}s`
                : "Resend confirmation email"}
          </button>

          <button
            type="button"
            onClick={startNewBooking}
            className="inline-flex items-center gap-2 px-3 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-white"
          >
            Start a separate booking
          </button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          You can reschedule as many times as you need — every request keeps your original booking
          details, history and confirmation.
        </p>
      </div>
    );
  }



  return (
    <form
      onSubmit={submit}
      className={`border border-border-strong bg-background/40 p-6 backdrop-blur-sm ${className}`}
    >
      <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        <CalendarClock size={14} aria-hidden className="text-[#e11d2e]" />
        {rescheduleRound > 0
          ? "Vocals & Lyrics — reschedule your video chat"
          : "Vocals & Lyrics — book your video chat"}
      </p>
      {rescheduleRound > 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-white/80">
          Your details are still here. Edit, remove or add slots below and send again — we'll use
          these new times instead of the ones you sent before.
        </p>
      ) : (
        <p className="mt-3 text-sm leading-relaxed text-white/80">
          Choosing the live vocal path? Share your timezone and up to 5 slots that work for you. We
          record your vocals over video chat, then build the track around them.
        </p>
      )}


      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Artist name
          </span>
          <input
            required
            maxLength={120}
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            className="mt-2 w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Contact email
          </span>
          <input
            required
            type="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-2 w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
          />
        </label>
      </div>

      <label className="mt-4 block">
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          <Globe size={12} aria-hidden /> Your timezone
        </span>
        <select
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="mt-2 w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
        >
          {zoneOptions.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
              {tz === browserZone ? " (detected)" : ""}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="mt-6">
        <legend className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Preferred time slots
        </legend>
        <div className="mt-3 space-y-3">
          {slots.map((slot, i) => {
            const hint = slotHint(slot);
            return (
            <div key={i} className="space-y-1">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex-1 min-w-[9rem]">
                <span className="sr-only">Slot {i + 1} date</span>
                <input
                  type="date"
                  min={todayISO()}
                  value={slot.date}
                  onChange={(e) => updateSlot(i, { date: e.target.value })}
                  className="w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
                />
              </label>
              <label className="flex-1 min-w-[7rem]">
                <span className="sr-only">Slot {i + 1} time</span>
                <input
                  type="time"
                  value={slot.time}
                  onChange={(e) => updateSlot(i, { time: e.target.value })}
                  className="w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
                />
              </label>
              {slots.length > 1 && (
                <button
                  type="button"
                  onClick={() => setSlots((prev) => prev.filter((_, idx) => idx !== i))}
                  aria-label={`Remove slot ${i + 1}`}
                  className="border border-border-strong p-3 text-white/70 transition-colors hover:border-white hover:text-white"
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              )}
            </div>
            {hint && (
              <p className="text-[11px]" style={{ color: hint.color }} aria-live="polite">
                {hint.text}
              </p>
            )}
            </div>
            );
          })}
        </div>
        {slots.length < 5 && (
          <button
            type="button"
            onClick={() => setSlots((prev) => [...prev, { date: "", time: "" }])}
            className="mt-3 inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4b8bff] transition-colors hover:text-white"
          >
            <Plus size={12} aria-hidden /> Add another slot
          </button>
        )}
      </fieldset>

      {booking && rescheduleRound > 0 && (
        <RescheduleHistory
          rounds={booking.rounds}
          currentSlots={slots}
          timezone={timezone}
          confirmedSlot={status?.confirmedSlot}
          className="mt-5"
        />
      )}

      <SlotAvailabilitySummary
        slots={slots}
        timezone={timezone}
        windows={windows}
        checkedAt={checkedAt}
        loading={checking}
        onRefresh={() => setAvailabilityTick((t) => t + 1)}
        className="mt-5"
      />

      <fieldset className="mt-6 border border-border-strong/60 p-4">
        <legend className="px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Recording permission
        </legend>
        <p className="text-xs leading-relaxed text-white/70">
          Choose what we're allowed to capture during your live session. Audio only is the default.
        </p>
        <div className="mt-3 space-y-2">
          {RECORDING_MODES.map((mode) => (
            <label
              key={mode.id}
              className={`flex cursor-pointer gap-3 border p-3 transition-colors ${
                recordingMode === mode.id
                  ? "border-[#e11d2e] bg-[#e11d2e]/5"
                  : "border-border hover:border-border-strong"
              }`}
            >
              <input
                type="radio"
                name="recording-mode"
                value={mode.id}
                checked={recordingMode === mode.id}
                onChange={() => {
                  setRecordingMode(mode.id);
                  setRecordingAck(false);
                }}
                className="mt-1 accent-[#e11d2e]"
              />
              <span>
                <span className="block text-sm font-semibold text-white">{mode.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-white/65">
                  {mode.summary}
                </span>
              </span>
            </label>
          ))}
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-white/80">
          <input
            type="checkbox"
            checked={recordingAck}
            onChange={(e) => setRecordingAck(e.target.checked)}
            className="mt-0.5 accent-[#e11d2e]"
          />
          <span aria-live="polite">
            I understand and agree to <span className="text-white">{selectedRecording.label}</span>{" "}
            for this session.
          </span>
        </label>
      </fieldset>



      <label className="mt-5 block">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Notes (optional)
        </span>
        <textarea
          rows={3}
          maxLength={1000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything we should know — mic setup, language, song references."
          className="mt-2 w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
        />
      </label>

      {error && (
        <p role="alert" className="mt-4 text-xs font-medium text-[#e11d2e]">
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
      <button
        type="submit"
        disabled={busy || !recordingAck}
        title={recordingAck ? undefined : "Acknowledge the recording mode to continue"}

        className="inline-flex items-center justify-center gap-2 bg-[#e11d2e] px-6 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-[#c4162a] disabled:cursor-not-allowed disabled:bg-[#e11d2e]/40"
      >
        {busy ? "Sending…" : rescheduleRound > 0 ? "Send my new times" : "Send my session times"}
      </button>
      <EmailPreviewModal
        artist={artist}
        email={email}
        timezone={timezone}
        packageLabel={pkg?.title ?? null}
        slots={slots}
        notes={notes}
        rescheduleRound={rescheduleRound}
        currentStatus={status?.status ?? null}
        confirmedSlot={
          status?.confirmedSlot?.date && status.confirmedSlot.time
            ? { date: status.confirmedSlot.date, time: status.confirmedSlot.time }
            : null
        }
      />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Times are recorded in your selected timezone — we convert on our side and confirm by email.
      </p>
    </form>
  );
}
