import { useMemo, useState } from "react";
import { Eye, Mail } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  buildSessionStatusEmail,
  buildSlotRequestConfirmationEmail,
  type SessionSlot,
} from "@/lib/vocal-session-email";
import { timeZoneLabel } from "@/lib/timezone";

type View = "request" | "confirmed";
type Format = "html" | "text";

export interface EmailPreviewModalProps {
  artist: string;
  email: string;
  timezone: string;
  packageLabel?: string | null;
  slots: SessionSlot[];
  notes?: string | null;
  rescheduleRound?: number;
  currentStatus?: string | null;
  confirmedSlot?: SessionSlot | null;
  meetingLink?: string | null;
  className?: string;
  label?: string;
}

/**
 * Renders the real confirmation email — same builders the mailer uses — so the
 * artist can check their slots and timezone read correctly before sending.
 */
export function EmailPreviewModal({
  artist,
  email,
  timezone,
  packageLabel = null,
  slots,
  notes = null,
  rescheduleRound = 0,
  currentStatus = null,
  confirmedSlot = null,
  meetingLink = null,
  className = "",
  label = "Preview confirmation email",
}: EmailPreviewModalProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("request");
  const [format, setFormat] = useState<Format>("html");

  const usableSlots = useMemo(
    () => slots.filter((s) => s.date && s.time),
    [slots],
  );

  const previewSlot = confirmedSlot?.date && confirmedSlot?.time ? confirmedSlot : usableSlots[0];

  const built = useMemo(() => {
    if (view === "confirmed") {
      return buildSessionStatusEmail({
        artist: artist || "Your name",
        status: "confirmed",
        timezone,
        packageLabel,
        slot: previewSlot ?? null,
        meetingLink,
      });
    }
    return buildSlotRequestConfirmationEmail({
      artist: artist || "Your name",
      timezone,
      packageLabel,
      slots: usableSlots.length > 0 ? usableSlots : [{ date: "—", time: "—" }],
      notes,
      rescheduleRound,
      currentStatus,
      confirmedSlot,
      meetingLink,
    });
  }, [
    view,
    artist,
    timezone,
    packageLabel,
    usableSlots,
    notes,
    rescheduleRound,
    currentStatus,
    confirmedSlot,
    meetingLink,
    previewSlot,
  ]);

  const tabClass = (active: boolean) =>
    `px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors ${
      active
        ? "border border-[#e11d2e] text-[#e11d2e]"
        : "border border-border-strong text-muted-foreground hover:text-white"
    }`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-2 border border-border-strong px-4 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:border-[#4b8bff] hover:text-[#4b8bff] ${className}`}
        >
          <Eye size={13} aria-hidden /> {label}
        </button>
      </DialogTrigger>
      <DialogContent className="overflow-y-auto sm:max-h-[90dvh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail size={16} aria-hidden className="text-[#e11d2e]" /> Email preview
          </DialogTitle>
          <DialogDescription>
            Exactly what lands in the inbox for your selected slots and timezone.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-1 gap-2 border border-border-strong/60 p-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="font-mono uppercase tracking-[0.16em] text-muted-foreground">To</dt>
            <dd className="break-all text-white/85">{email || "your@email.com"}</dd>
          </div>
          <div>
            <dt className="font-mono uppercase tracking-[0.16em] text-muted-foreground">Subject</dt>
            <dd className="text-white/85">{built.subject}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="font-mono uppercase tracking-[0.16em] text-muted-foreground">
              Timezone used
            </dt>
            <dd className="text-white/85">{timeZoneLabel(timezone)}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <button type="button" className={tabClass(view === "request")} onClick={() => setView("request")}>
            {rescheduleRound > 0 ? "Reschedule receipt" : "Request received"}
          </button>
          <button
            type="button"
            className={tabClass(view === "confirmed")}
            onClick={() => setView("confirmed")}
          >
            Slot confirmed
          </button>
          <span className="grow" />
          <button type="button" className={tabClass(format === "html")} onClick={() => setFormat("html")}>
            Rendered
          </button>
          <button type="button" className={tabClass(format === "text")} onClick={() => setFormat("text")}>
            Plain text
          </button>
        </div>

        {format === "html" ? (
          <iframe
            title="Confirmation email preview"
            sandbox=""
            srcDoc={built.html}
            className="h-[55dvh] w-full border border-border-strong bg-white"
          />
        ) : (
          <pre className="h-[55dvh] overflow-auto whitespace-pre-wrap border border-border-strong bg-background/60 p-4 text-xs leading-relaxed text-white/80">
            {built.text}
          </pre>
        )}

        {view === "confirmed" && !previewSlot && (
          <p className="text-xs text-muted-foreground">
            Pick a slot above to see the confirmed-session version with your real date and time.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default EmailPreviewModal;
