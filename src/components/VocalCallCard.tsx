import { useState } from "react";
import { Check, Copy, MessageCircle } from "lucide-react";
import { CALL_INSTRUCTIONS } from "@/lib/vocal-call-link";

type Props = {
  meetingLink: string;
  date?: string;
  altDate?: string;
  window?: string;
  timezone?: string;
  className?: string;
  title?: string;
};

/**
 * Shows the WhatsApp video-call link plus joining instructions.
 * Used in the track builder review step and on the order confirmation.
 */
export function VocalCallCard({
  meetingLink,
  date,
  altDate,
  window: slotWindow,
  timezone,
  className = "",
  title = "Your vocal call",
}: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(meetingLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className={`border border-border bg-ink/40 p-4 text-start ${className}`}>
      <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        <MessageCircle size={12} aria-hidden />
        {title}
      </p>

      {(date || slotWindow) && (
        <p className="mt-2 text-sm text-white">
          {date || "Date to be confirmed"}
          {slotWindow ? ` · ${slotWindow}` : ""}
          {timezone ? ` (${timezone})` : ""}
          {altDate ? ` · backup ${altDate}` : ""}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={meetingLink}
          target="_blank"
          rel="noreferrer"
          className="bg-[#e11d2e] px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white hover:bg-[#c4162a]"
        >
          Start on WhatsApp
        </a>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-2 border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/85 hover:border-border-strong"
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
      <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{meetingLink}</p>
      <p aria-live="polite" className="sr-only">
        {copied ? "WhatsApp call link copied to clipboard" : ""}
      </p>

      <ul className="mt-3 list-disc space-y-1 ps-5 text-xs text-white/75">
        {CALL_INSTRUCTIONS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}
