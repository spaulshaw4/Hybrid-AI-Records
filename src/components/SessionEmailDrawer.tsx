import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, Mail, X } from "lucide-react";
import {
  buildSessionStatusEmail,
  buildSlotRequestConfirmationEmail,
  type SessionSlot,
  type SessionStatus,
} from "@/lib/vocal-session-email";
import { timeZoneLabel } from "@/lib/timezone";
import { SESSION_EMAIL_FROM, SESSION_EMAIL_REPLY_TO } from "@/lib/session-email-identity";
import { downloadEml } from "@/lib/eml";

import type { SessionEmailEntry, SessionInboxRow } from "@/lib/session-email-log.functions";


type Variant = "request" | "confirmed";
type Format = "html" | "text";

const STATUS_KINDS: SessionStatus[] = ["confirmed", "rescheduled", "declined", "cancelled"];

function asSlot(slot: { date?: string; time?: string } | null | undefined): SessionSlot | null {
  return slot?.date && slot?.time ? { date: slot.date, time: slot.time } : null;
}

function when(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/**
 * Detail drawer for one logged notification email: subject line, the rendered
 * body (request vs confirmed variant, HTML or plain text), and the full
 * delivery timeline for the session it belongs to.
 */
export function SessionEmailDrawer({
  row,
  entry,
  onClose,
}: {
  row: SessionInboxRow;
  entry: SessionEmailEntry | null;
  onClose: () => void;
}) {
  const initialVariant: Variant =
    entry && STATUS_KINDS.some((k) => entry.kind.includes(k)) ? "confirmed" : "request";
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [format, setFormat] = useState<Format>("html");

  const entrySlot = asSlot(entry?.slot);
  const confirmedSlot = asSlot(row.confirmedSlot);

  const rendered = useMemo(() => {
    if (variant === "confirmed") {
      const status = (STATUS_KINDS.find((k) => entry?.kind.includes(k)) ??
        (STATUS_KINDS.includes(row.status as SessionStatus)
          ? (row.status as SessionStatus)
          : "confirmed")) as SessionStatus;
      return buildSessionStatusEmail({
        artist: row.artist,
        status,
        timezone: row.timezone,
        packageLabel: row.packageLabel,
        slot: entrySlot ?? confirmedSlot,
        meetingLink: row.meetingLink,
      });
    }
    const slots = [entrySlot ?? confirmedSlot].filter(Boolean) as SessionSlot[];
    return buildSlotRequestConfirmationEmail({
      artist: row.artist,
      timezone: row.timezone,
      packageLabel: row.packageLabel,
      slots,
      currentStatus: row.status,
      confirmedSlot,
      meetingLink: row.meetingLink,
    });
  }, [variant, entry, row, entrySlot, confirmedSlot]);

  const timeline = [...row.emails].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  /** Exact envelope used at send time, plus log identifiers for support tickets. */
  const headers: [string, string][] = [
    ["From", SESSION_EMAIL_FROM],
    ["Reply-To", SESSION_EMAIL_REPLY_TO],
    ["To", entry?.recipient ?? row.email],
    ["Subject", entry?.subject ?? rendered.subject],
    ["Kind", entry?.kind ?? `${variant} (preview)`],
    ["Outcome", entry?.outcome ?? "not sent yet"],
    ["Date", entry ? when(entry.createdAt) : "—"],
    ["Timezone", timeZoneLabel(row.timezone)],
    ["Log ID", entry?.id ?? "—"],
    ["Request ID", row.id],
  ];

  /** Download the currently shown message as an RFC 822 (.eml) file. */
  function handleDownloadEml() {
    const sentAt = entry ? new Date(entry.createdAt) : new Date();
    downloadEml({
      from: SESSION_EMAIL_FROM,
      replyTo: SESSION_EMAIL_REPLY_TO,
      to: entry?.recipient ?? row.email,
      subject: entry?.subject ?? rendered.subject,
      html: rendered.html,
      text: rendered.text,
      date: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
      extraHeaders: [
        ["X-Hybrid-Kind", entry?.kind ?? `${variant} (preview)`],
        ["X-Hybrid-Outcome", entry?.outcome ?? "not sent yet"],
        ["X-Hybrid-Timezone", timeZoneLabel(row.timezone)],
        ["X-Hybrid-Log-Id", entry?.id ?? "none"],
        ["X-Hybrid-Request-Id", row.id],
        ...(entry?.reason ? ([["X-Hybrid-Failure-Reason", entry.reason]] as [string, string][]) : []),
      ],
    });
  }


  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close email details"
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border-strong bg-background/95 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              Email detail
            </p>
            <h2 className="mt-2 break-words font-display text-lg font-bold">
              {entry?.subject ?? rendered.subject}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {entry ? `${entry.kind} → ${entry.recipient}` : row.email} ·{" "}
              {timeZoneLabel(row.timezone)}
            </p>
            {entry && entry.outcome !== "sent" ? (
              <p className="mt-1 text-sm text-[#e11d2e]">
                {entry.outcome}
                {entry.reason ? ` — ${entry.reason}` : ""}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-border-strong p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {(["request", "confirmed"] as Variant[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setVariant(v)}
              className={`border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] ${
                variant === v
                  ? "border-[#e11d2e] text-[#e11d2e]"
                  : "border-border-strong text-muted-foreground"
              }`}
            >
              {v === "request" ? "Request variant" : "Confirmed variant"}
            </button>
          ))}
          <span className="mx-1 w-px bg-border-strong" />
          {(["html", "text"] as Format[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              className={`border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] ${
                format === f
                  ? "border-[#e11d2e] text-[#e11d2e]"
                  : "border-border-strong text-muted-foreground"
              }`}
            >
              {f}
            </button>
          ))}
          <span className="mx-1 w-px bg-border-strong" />
          <button
            type="button"
            onClick={handleDownloadEml}
            title="Download this message as an RFC 822 .eml file"
            className="flex items-center gap-1.5 border border-border-strong px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-[#e11d2e] hover:text-[#e11d2e]"
          >
            <Download className="h-3 w-3" />
            Download .eml
          </button>
        </div>


        <div className="mt-5 border border-border-strong/70">
          <p className="border-b border-border-strong/70 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Headers
          </p>
          <dl className="divide-y divide-border-strong/40 text-xs">
            {headers.map(([label, value]) => (
              <div key={label} className="flex gap-3 px-3 py-1.5">
                <dt className="w-28 shrink-0 font-mono uppercase tracking-[0.12em] text-muted-foreground">
                  {label}
                </dt>
                <dd className="min-w-0 flex-1 break-words font-mono text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        {entry && entry.outcome !== "sent" ? (
          <div className="mt-4 border border-[#e11d2e]/60 bg-[#e11d2e]/5 p-3">
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#e11d2e]">
              <AlertTriangle className="h-3.5 w-3.5" /> Delivery error
            </p>
            <p className="mt-2 text-sm text-foreground">
              Outcome: <span className="font-mono">{entry.outcome}</span>
            </p>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-[#e11d2e]">
              {entry.reason ?? "No provider reason was recorded for this failure."}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              Logged {when(entry.createdAt)} · log id {entry.id}
            </p>
          </div>
        ) : null}

        <p className="mt-4 text-xs text-muted-foreground">
          Rendered subject: <span className="font-mono">{rendered.subject}</span>
        </p>


        <div className="mt-2 border border-border-strong bg-white">
          {format === "html" ? (
            <iframe
              title="Rendered email body"
              srcDoc={rendered.html}
              className="h-[420px] w-full"
              sandbox=""
            />
          ) : (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 text-xs text-black">
              {rendered.text}
            </pre>
          )}
        </div>

        <div className="mt-6 border-t border-border-strong pt-4">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Delivery timeline ({timeline.length})
          </p>
          {timeline.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" /> No emails logged for this session yet.
            </p>
          ) : (
            <ol className="space-y-3">
              {timeline.map((e) => {
                const ok = e.outcome === "sent";
                const active = e.id === entry?.id;
                return (
                  <li
                    key={e.id}
                    className={`flex gap-3 border px-3 py-2 text-sm ${
                      active ? "border-[#e11d2e]" : "border-border-strong/60"
                    }`}
                  >
                    {ok ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#e11d2e]" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{e.subject}</p>
                      <p className="text-xs text-muted-foreground">
                        {e.kind} · {e.outcome} · {when(e.createdAt)}
                      </p>
                      {!ok && e.reason ? (
                        <p className="text-xs text-[#e11d2e]">{e.reason}</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}
