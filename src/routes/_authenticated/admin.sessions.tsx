import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Download, Loader2, Mail, RefreshCw, Search, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  listSessionInbox,
  type SessionEmailEntry,
  type SessionInboxRow,
} from "@/lib/session-email-log.functions";
import { SessionEmailDrawer } from "@/components/SessionEmailDrawer";
import { RetryEmailButton } from "@/components/RetryEmailButton";
import { BulkRetryButton } from "@/components/BulkRetryButton";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";



export const Route = createFileRoute("/_authenticated/admin/sessions")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/sessions",
      title: "Session Email Inbox — Hybrid AI Records",
      description: "Private staff inbox showing the email delivery and status history for every scheduled vocal session.",
      socialTitle: "Session Email Inbox — Hybrid AI Records",
      socialDescription: "Delivery and status history for every scheduled vocal session.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminSessions,
});

const STATUSES = [
  "all",
  "requested",
  "confirmed",
  "rescheduled",
  "declined",
  "cancelled",
] as const;

function when(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function SessionCard({
  row,
  onOpenEmail,
  onRetried,
}: {
  row: SessionInboxRow;
  onOpenEmail: (row: SessionInboxRow, entry: SessionEmailEntry | null) => void;
  onRetried: () => void;
}) {
  const failed = row.emails.filter((e) => e.outcome !== "sent").length;

  const slot = row.confirmedSlot;

  return (
    <article className="border border-border-strong bg-background/40 p-5 backdrop-blur-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">{row.artist}</h2>
          <p className="text-sm text-muted-foreground">
            {row.email} · {row.timezone}
            {row.packageLabel ? ` · ${row.packageLabel}` : ""}
          </p>
          {slot?.date && slot?.time ? (
            <p className="mt-1 text-sm">
              Confirmed slot:{" "}
              <span className="font-mono">
                {slot.date} {slot.time}
              </span>
            </p>
          ) : null}
        </div>
        <div className="text-right">
          <span className="border border-border-strong px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em]">
            {row.status}
          </span>
          <p className="mt-2 text-xs text-muted-foreground">Requested {when(row.createdAt)}</p>
        </div>
      </div>

      <div className="mt-4 border-t border-border-strong pt-4">
        <p className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          <Mail className="h-3.5 w-3.5" />
          Email history ({row.emails.length})
          {failed > 0 ? (
            <span className="text-[#e11d2e]">· {failed} failed</span>
          ) : null}
        </p>

        {row.emails.length === 0 ? (
          <button
            type="button"
            onClick={() => onOpenEmail(row, null)}
            className="text-left text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            No notification emails recorded yet — preview what will be sent.
          </button>
        ) : (
          <ul className="space-y-2">
            {row.emails.map((entry) => {
              const ok = entry.outcome === "sent";
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onOpenEmail(row, entry)}
                    title="Open email details"
                    className="flex w-full flex-wrap items-start gap-3 border border-border-strong/60 px-3 py-2 text-left text-sm transition-colors hover:border-[#e11d2e] hover:bg-background/60"
                  >
                    {ok ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#e11d2e]" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{entry.subject}</p>
                      <p className="text-xs text-muted-foreground">
                        {entry.kind} → {entry.recipient}
                        {entry.slot?.date ? ` · ${entry.slot.date} ${entry.slot.time ?? ""}` : ""}
                      </p>
                      {!ok && entry.reason ? (
                        <p className="text-xs text-[#e11d2e]">Failure: {entry.reason}</p>
                      ) : null}
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {when(entry.createdAt)}
                    </span>
                  </button>
                  {!ok ? (
                    <div className="mt-1 flex justify-end">
                      <RetryEmailButton entry={entry} onRetried={onRetried} />
                    </div>
                  ) : null}
                </li>

              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
}


type EmailEntry = SessionInboxRow["emails"][number];

type CsvColumn = {
  key: string;
  label: string;
  group: "Session" | "Email";
  value: (row: SessionInboxRow, email: EmailEntry | null) => string;
};

const CSV_COLUMNS: CsvColumn[] = [
  { key: "session_id", label: "Session ID", group: "Session", value: (r) => r.id },
  { key: "artist", label: "Artist", group: "Session", value: (r) => r.artist },
  { key: "artist_email", label: "Artist email", group: "Session", value: (r) => r.email },
  { key: "timezone", label: "Timezone", group: "Session", value: (r) => r.timezone },
  { key: "package", label: "Package", group: "Session", value: (r) => r.packageLabel ?? "" },
  { key: "session_status", label: "Session status", group: "Session", value: (r) => r.status },
  {
    key: "confirmed_date",
    label: "Confirmed date",
    group: "Session",
    value: (r) => r.confirmedSlot?.date ?? "",
  },
  {
    key: "confirmed_time",
    label: "Confirmed time",
    group: "Session",
    value: (r) => r.confirmedSlot?.time ?? "",
  },
  {
    key: "meeting_link",
    label: "Meeting link",
    group: "Session",
    value: (r) => r.meetingLink ?? "",
  },
  {
    key: "session_requested_at",
    label: "Requested at",
    group: "Session",
    value: (r) => r.createdAt,
  },
  { key: "email_id", label: "Email ID", group: "Email", value: (_r, e) => e?.id ?? "" },
  { key: "email_kind", label: "Notification type", group: "Email", value: (_r, e) => e?.kind ?? "" },
  {
    key: "email_recipient",
    label: "Recipient",
    group: "Email",
    value: (_r, e) => e?.recipient ?? "",
  },
  { key: "email_subject", label: "Subject", group: "Email", value: (_r, e) => e?.subject ?? "" },
  { key: "email_outcome", label: "Outcome", group: "Email", value: (_r, e) => e?.outcome ?? "" },
  { key: "email_reason", label: "Failure reason", group: "Email", value: (_r, e) => e?.reason ?? "" },
  {
    key: "email_slot_date",
    label: "Slot date",
    group: "Email",
    value: (_r, e) => e?.slot?.date ?? "",
  },
  {
    key: "email_slot_time",
    label: "Slot time",
    group: "Email",
    value: (_r, e) => e?.slot?.time ?? "",
  },
  { key: "email_sent_at", label: "Sent at", group: "Email", value: (_r, e) => e?.createdAt ?? "" },
];

const ALL_CSV_KEYS = CSV_COLUMNS.map((c) => c.key);

function csvCell(value: unknown) {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function buildCsv(rows: SessionInboxRow[], selectedKeys: string[]) {
  const cols = CSV_COLUMNS.filter((c) => selectedKeys.includes(c.key));
  if (cols.length === 0) return "";
  const lines = [cols.map((c) => c.key).join(",")];
  for (const row of rows) {
    const emails: (EmailEntry | null)[] = row.emails.length > 0 ? row.emails : [null];
    for (const email of emails) {
      lines.push(cols.map((c) => csvCell(c.value(row, email))).join(","));
    }
  }
  return lines.join("\r\n");
}


const EMAIL_STATUSES = ["all", "sent", "failed", "pending"] as const;

/** Export scope: every email row, only non-sent emails, or only sessions with no email logged. */
const EXPORT_SCOPES = [
  { value: "all", label: "All emails" },
  { value: "failed", label: "Failed only" },
  { value: "pending", label: "Pending (no email yet)" },
] as const;

function AdminSessions() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [emailStatus, setEmailStatus] = useState<(typeof EMAIL_STATUSES)[number]>("all");
  const [emailKind, setEmailKind] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [csvKeys, setCsvKeys] = useState<string[]>(ALL_CSV_KEYS);
  const [showColumns, setShowColumns] = useState(false);
  const [xlsxBusy, setXlsxBusy] = useState(false);

  const [detail, setDetail] = useState<{
    row: SessionInboxRow;
    entry: SessionEmailEntry | null;
  } | null>(null);
  const [exportScope, setExportScope] =
    useState<(typeof EXPORT_SCOPES)[number]["value"]>("all");



  const fetchInbox = useServerFn(listSessionInbox);
  const query = useQuery({
    queryKey: ["session-inbox", status, search, emailStatus, emailKind, from, to],
    queryFn: () =>
      fetchInbox({ data: { status, search, emailStatus, emailKind, from, to, limit: 100 } }),
  });


  const [live, setLive] = useState(false);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const refetch = query.refetch;

  useEffect(() => {
    const channel = supabase
      .channel("admin-session-inbox")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "session_email_log" },
        () => {
          setLastEvent(new Date().toLocaleTimeString());
          refetch();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "vocal_session_requests" },
        () => {
          setLastEvent(new Date().toLocaleTimeString());
          refetch();
        },
      )
      .subscribe((state) => setLive(state === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refetch]);

  const rows = query.data?.rows ?? [];

  

  /** Narrow the exported rows: all, only failed emails, or only sessions with no email yet. */
  function scopeRows(scope: (typeof EXPORT_SCOPES)[number]["value"]): SessionInboxRow[] {
    if (scope === "failed") {
      return rows
        .map((r) => ({ ...r, emails: r.emails.filter((e) => e.outcome !== "sent") }))
        .filter((r) => r.emails.length > 0);
    }
    if (scope === "pending") {
      return rows.filter((r) => r.emails.length === 0);
    }
    return rows;
  }

  const scopedRows = scopeRows(exportScope);
  const scopedCount =
    exportScope === "pending"
      ? scopedRows.length
      : scopedRows.reduce((n, r) => n + r.emails.length, 0);

  function exportFileName(extension: "csv" | "xlsx") {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const term = search ? `_${search.replace(/\W+/g, "-")}` : "";
    return `session-email-log_${status}_${exportScope}${term}_${stamp}.${extension}`;
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    const csv = buildCsv(scopedRows, csvKeys);
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, exportFileName("csv"));
  }

  /** Same scope + column picker as the CSV export, delivered as a real worksheet. */
  async function exportXlsx() {
    setXlsxBusy(true);
    try {
      const { default: writeXlsxFile } = await import("write-excel-file/browser");
      const cols = CSV_COLUMNS.filter((c) => csvKeys.includes(c.key));
      if (cols.length === 0) return;

      const header = cols.map((c) => ({
        type: String,
        value: c.label,
        fontWeight: "bold" as const,
        backgroundColor: "#1a1a1a",
        color: "#ffffff",
      }));

      const body = scopedRows.flatMap((row) => {
        const emails: (EmailEntry | null)[] = row.emails.length > 0 ? row.emails : [null];
        return emails.map((email) =>
          cols.map((c) => ({ type: String, value: c.value(row, email) || undefined })),
        );
      });

      const file = writeXlsxFile([header, ...body], {
        sheet: "Email log",
        columns: cols.map((c) => ({ width: Math.min(48, Math.max(14, c.label.length + 6)) })),
      });

      await file.toFile(exportFileName("xlsx"));

    } finally {
      setXlsxBusy(false);
    }
  }



  const forbidden = query.error
    ? /forbidden|unauthorized|permission/i.test(String(query.error))
    : false;


  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow">
          <span className="text-[#e11d2e]">/ Staff</span>{" "}
          <span className="text-white">— Session inbox</span>
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Session Email Inbox
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Every scheduled vocal session with its full notification history — receipts,
          confirmations, reschedules, declines and cancellations, plus whether each email
          was delivered or failed.
        </p>
        <p className="mt-3 inline-flex items-center gap-2 border border-border-strong px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          <Radio className={`h-3.5 w-3.5 ${live ? "text-emerald-400 animate-pulse" : "text-muted-foreground"}`} />
          {live ? "Live — updates stream in automatically" : "Connecting live updates…"}
          {lastEvent ? <span className="text-white">· last update {lastEvent}</span> : null}
        </p>
      </header>


      <form
        className="mb-6 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(searchInput.trim());
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Status
          </span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}
            className="border border-border-strong bg-background/40 px-3 py-2 text-sm"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Email status
          </span>
          <select
            value={emailStatus}
            onChange={(e) => setEmailStatus(e.target.value as (typeof EMAIL_STATUSES)[number])}
            className="border border-border-strong bg-background/40 px-3 py-2 text-sm"
          >
            {EMAIL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "Any email status" : s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Notification type
          </span>
          <select
            value={emailKind}
            onChange={(e) => setEmailKind(e.target.value)}
            className="border border-border-strong bg-background/40 px-3 py-2 text-sm"
          >
            <option value="all">All types</option>
            {(query.data?.availableKinds ?? []).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
            {emailKind !== "all" && !(query.data?.availableKinds ?? []).includes(emailKind) ? (
              <option value={emailKind}>{emailKind}</option>
            ) : null}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            From
          </span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-border-strong bg-background/40 px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            To
          </span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="border border-border-strong bg-background/40 px-3 py-2 text-sm"
          />
        </label>


        <label className="flex flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Search artist or email
          </span>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Artist name or email"
            className="w-full border border-border-strong bg-background/40 px-3 py-2 text-sm"
          />
        </label>

        <Button type="submit" variant="outline" className="gap-2">
          <Search className="h-4 w-4" /> Filter
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setStatus("all");
            setEmailStatus("all");
            setEmailKind("all");
            setFrom("");
            setTo("");
            setSearchInput("");
            setSearch("");
          }}
        >
          Clear
        </Button>

        <Button
          type="button"
          variant="ghost"
          className="gap-2"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </Button>
        <select
          value={exportScope}
          onChange={(e) =>
            setExportScope(e.target.value as (typeof EXPORT_SCOPES)[number]["value"])
          }
          aria-label="Export scope"
          className="h-9 rounded-md border border-border/60 bg-background/60 px-2 text-sm"
        >
          {EXPORT_SCOPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={exportCsv}
          disabled={scopedCount === 0 || csvKeys.length === 0}
          title={
            scopedCount === 0
              ? "Nothing to export for this scope"
              : csvKeys.length === 0
                ? "Select at least one column"
                : exportScope === "pending"
                  ? `Export ${scopedCount} sessions awaiting email`
                  : `Export ${scopedCount} email records`
          }
        >
          <Download className="h-4 w-4" />
          Export CSV{scopedCount > 0 ? ` (${scopedCount})` : ""}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() => void exportXlsx()}
          disabled={scopedCount === 0 || csvKeys.length === 0 || xlsxBusy}
          title={
            scopedCount === 0
              ? "Nothing to export for this scope"
              : csvKeys.length === 0
                ? "Select at least one column"
                : `Export ${scopedCount} records as an Excel worksheet`
          }
        >
          <Download className="h-4 w-4" />
          {xlsxBusy ? "Building XLSX…" : `Export XLSX${scopedCount > 0 ? ` (${scopedCount})` : ""}`}
        </Button>

        <BulkRetryButton
          rows={scopedRows}
          scopeLabel={
            EXPORT_SCOPES.find((s) => s.value === exportScope)?.label ?? "current view"
          }
          onRetried={() => void query.refetch()}
        />


        <div className="relative">
          <Button
            type="button"
            variant="ghost"
            className="gap-2"
            onClick={() => setShowColumns((v) => !v)}
          >
            Columns ({csvKeys.length}/{ALL_CSV_KEYS.length})
          </Button>
          {showColumns ? (
            <div className="absolute right-0 z-30 mt-2 w-72 border border-border-strong bg-background/95 p-4 backdrop-blur-md">
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  CSV columns
                </span>
                <div className="flex gap-2 text-[11px]">
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setCsvKeys(ALL_CSV_KEYS)}
                  >
                    All
                  </button>
                  <button type="button" className="underline" onClick={() => setCsvKeys([])}>
                    None
                  </button>
                </div>
              </div>
              <div className="max-h-72 space-y-3 overflow-y-auto">
                {(["Session", "Email"] as const).map((group) => (
                  <div key={group}>
                    <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[#e11d2e]">
                      {group}
                    </p>
                    {CSV_COLUMNS.filter((c) => c.group === group).map((col) => (
                      <label key={col.key} className="flex items-center gap-2 py-0.5 text-sm">
                        <input
                          type="checkbox"
                          checked={csvKeys.includes(col.key)}
                          onChange={(e) =>
                            setCsvKeys((prev) =>
                              e.target.checked
                                ? ALL_CSV_KEYS.filter((k) => k === col.key || prev.includes(k))
                                : prev.filter((k) => k !== col.key),
                            )
                          }
                        />
                        {col.label}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

      </form>


      {forbidden ? (
        <p className="border border-[#e11d2e]/50 bg-[#e11d2e]/10 p-4 text-sm">
          This inbox is limited to admin and staff accounts.
        </p>
      ) : query.error ? (
        <p className="border border-[#e11d2e]/50 bg-[#e11d2e]/10 p-4 text-sm">
          Could not load sessions: {String(query.error)}
        </p>
      ) : query.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading sessions…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions match this filter.</p>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <SessionCard
              key={row.id}
              row={row}
              onOpenEmail={(r, entry) => setDetail({ row: r, entry })}
              onRetried={() => void query.refetch()}

            />
          ))}
        </div>
      )}

      {detail ? (
        <SessionEmailDrawer
          row={detail.row}
          entry={detail.entry}
          onClose={() => setDetail(null)}
        />
      ) : null}

    </main>
  );
}
