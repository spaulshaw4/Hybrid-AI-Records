import { useMemo } from "react";
import { CalendarPlus, Download } from "lucide-react";
import { toast } from "sonner";
import {
  buildGoogleCalendarUrl,
  buildIcsFile,
  icsFileName,
  type CalendarEventInput,
} from "@/lib/calendar-invite";

interface Props extends CalendarEventInput {
  className?: string;
  label?: string;
}

/**
 * Add-to-calendar controls for a booked vocal session: a Google Calendar
 * one-click link and a downloadable .ics for Apple Calendar / Outlook.
 */
export function CalendarExportLinks({ className = "", label, ...event }: Props) {
  const googleUrl = useMemo(() => buildGoogleCalendarUrl(event), [event]);
  const ics = useMemo(() => buildIcsFile(event), [event]);

  if (!googleUrl || !ics) return null;

  const downloadIcs = () => {
    try {
      const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = icsFileName(event);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Calendar file downloaded", {
        description: "Open it to add the session to Apple Calendar or Outlook.",
      });
    } catch {
      toast.error("Couldn't create the calendar file", {
        description: "Try the Google Calendar link instead.",
      });
    }
  };

  const btn =
    "inline-flex min-h-11 items-center gap-2 border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:border-[#4b8bff] hover:text-[#4b8bff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]";

  return (
    <div className={className}>
      {label ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          {label}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <a href={googleUrl} target="_blank" rel="noreferrer noopener" className={btn}>
          <CalendarPlus size={13} aria-hidden /> Google Calendar
        </a>
        <button type="button" onClick={downloadIcs} className={btn}>
          <Download size={13} aria-hidden /> Download .ics
        </button>
      </div>
    </div>
  );
}
