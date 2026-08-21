import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useEffect, useMemo, useState } from "react";
import { Copy, Download, FileText, Search, Trash2 } from "lucide-react";
import {
  matchesReceiptQuery,
  readReceiptHistory,
  removeReceipt,
  clearReceiptHistory,
  type ReceiptRecord,
} from "@/lib/receipt-history";

export const Route = createFileRoute("/receipts")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/receipts",
      title: "Receipt History — Hybrid AI Records",
      description: "Search your recent Hybrid AI Records track submissions and open, download, or track the receipt for any of them.",
      socialTitle: "Receipt History — Hybrid AI Records",
      socialDescription: "Your recent track submissions with quick links to each receipt and live status tracking.",
      type: "website",
      card: "summary_large_image",
      noindex: true,
    }),
  component: ReceiptsPage,
});

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function ReceiptsPage() {
  const [records, setRecords] = useState<ReceiptRecord[]>([]);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setRecords(readReceiptHistory());
  }, []);

  const results = useMemo(
    () =>
      records
        .filter((r) => matchesReceiptQuery(r, query))
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
    [records, query],
  );

  const copyRef = async (reference: string | null) => {
    if (!reference) return;
    try {
      await navigator.clipboard.writeText(reference);
      setMessage(`Reference ${reference} copied to your clipboard.`);
    } catch {
      setMessage("Copying isn't allowed in this browser — select the code and copy it.");
    }
  };

  const openPdf = async (record: ReceiptRecord, download: boolean) => {
    const id = `${record.reference}-${record.submittedAt}`;
    setBusy(id);
    setMessage("");
    try {
      const { buildApplicationPdf } = await import("@/lib/application-pdf");
      const { doc, filename } = buildApplicationPdf({
        reference: record.reference,
        artist: record.artist,
        email: record.email,
        packageLabel: record.packageLabel,
        link: record.link,
        notes: record.notes,
        acknowledged: record.acknowledged,
        attachment: record.attachment,
        timeline: record.timeline,
        submittedAt: new Date(record.submittedAt),
      });
      if (download) {
        doc.save(filename);
      } else {
        const url = doc.output("bloburl") as unknown as string;
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      console.error(err);
      setMessage("We couldn't rebuild that receipt in this browser. Try the download button instead.");
    } finally {
      setBusy(null);
    }
  };

  const remove = (record: ReceiptRecord) => {
    removeReceipt(record.reference, record.submittedAt);
    setRecords(readReceiptHistory());
    setMessage("Receipt removed from this device.");
  };

  const clearAll = () => {
    clearReceiptHistory();
    setRecords([]);
    setMessage("Receipt history cleared from this device.");
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-16 sm:px-8">
      <PortalBreadcrumb trail={[{ label: "Receipts" }]} />

      <h1 className="mt-2 text-3xl font-black uppercase tracking-tight text-white sm:text-4xl">
        Receipt <span className="text-primary">History</span>
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
        Every track submission made from this browser, with quick links to view or download the
        receipt and follow production status. This list is stored on your device only.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by reference, artist, email, package or file"
            aria-label="Search your receipts"
            className="w-full border border-border-strong bg-background/40 py-3 ps-10 pe-3 text-sm text-white placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </div>
        {records.length > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="inline-flex items-center justify-center gap-2 border border-border-strong px-4 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:border-primary hover:text-white"
          >
            <Trash2 size={14} aria-hidden="true" />
            Clear history
          </button>
        )}
      </div>

      {message && (
        <p
          role="status"
          aria-live="polite"
          className="mt-4 font-mono text-[11px] uppercase tracking-[0.16em] text-[#8fb6ff]"
        >
          {message}
        </p>
      )}

      <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
        {results.length} {results.length === 1 ? "receipt" : "receipts"}
        {query.trim() ? ` matching “${query.trim()}”` : ""}
      </p>

      {results.length === 0 ? (
        <div className="mt-6 border border-dashed border-border-strong bg-background/30 p-10 text-center">
          <FileText size={28} aria-hidden="true" className="mx-auto text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">
            {records.length === 0
              ? "No submissions yet from this browser. Once you submit a track, its receipt shows up here."
              : "No receipts match that search."}
          </p>
          <Link
            to="/"
            className="mt-6 inline-block border border-primary px-5 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-primary"
          >
            Start a track
          </Link>
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
          {results.map((r) => {
            const id = `${r.reference}-${r.submittedAt}`;
            return (
              <li
                key={id}
                className="border border-border-strong bg-background/30 p-5 transition-colors hover:border-primary/60"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
                      {r.reference ?? "No reference"}
                    </p>
                    <p className="mt-1 truncate text-lg font-bold text-white">{r.artist}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {r.packageLabel} · {fmt(r.submittedAt)}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {r.email}
                      {r.attachment ? ` · ${r.attachment.name}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.reference && (
                      <button
                        type="button"
                        onClick={() => copyRef(r.reference)}
                        className="inline-flex items-center gap-1.5 border border-border-strong px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary hover:text-white"
                      >
                        <Copy size={12} aria-hidden="true" />
                        Copy code
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openPdf(r, false)}
                      disabled={busy === id}
                      className="inline-flex items-center gap-1.5 border border-primary px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white transition-colors hover:bg-primary disabled:opacity-60"
                    >
                      <FileText size={12} aria-hidden="true" />
                      View receipt
                    </button>
                    <button
                      type="button"
                      onClick={() => openPdf(r, true)}
                      disabled={busy === id}
                      className="inline-flex items-center gap-1.5 border border-border-strong px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary hover:text-white disabled:opacity-60"
                    >
                      <Download size={12} aria-hidden="true" />
                      PDF
                    </button>
                    {r.reference && (
                      <Link
                        to="/order-status"
                        search={{ ref: r.reference }}
                        className="inline-flex items-center border border-border-strong px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#8fb6ff] transition-colors hover:border-primary hover:text-white"
                      >
                        Order status
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(r)}
                      aria-label={`Remove receipt ${r.reference ?? r.artist}`}
                      className="inline-flex items-center border border-border-strong p-2 text-muted-foreground transition-colors hover:border-primary hover:text-white"
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {r.notes && (
                  <p className="mt-4 border-t border-border-strong pt-3 text-xs text-muted-foreground">
                    {r.notes}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
