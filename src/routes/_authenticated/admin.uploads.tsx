import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listUploadAudit, type UploadAuditRow } from "@/lib/upload-audit.functions";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

export const Route = createFileRoute("/_authenticated/admin/uploads")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/uploads",
      title: "Upload Audit Log — Hybrid AI Records",
      description: "Private staff log of every artist file upload, replacement and deletion with its order reference.",
      socialTitle: "Upload Audit Log — Hybrid AI Records",
      socialDescription: "Private staff log of artist file uploads, replacements and deletions.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminUploads,
});

const ACTIONS = ["all", "upload", "replace", "delete"] as const;
const OUTCOMES = ["all", "success", "failed"] as const;

function formatSize(bytes: number | null) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AdminUploads() {
  const [action, setAction] = useState<(typeof ACTIONS)[number]>("all");
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const fetchAudit = useServerFn(listUploadAudit);
  const query = useQuery({
    queryKey: ["upload-audit", action, outcome, search],
    queryFn: () => fetchAudit({ data: { action, outcome, search, limit: 200 } }),
  });

  const rows: UploadAuditRow[] = query.data?.rows ?? [];
  const forbidden = query.error ? /forbidden|unauthorized|permission/i.test(String(query.error)) : false;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow">
          <span className="text-[#e11d2e]">/ Staff</span>{" "}
          <span className="text-white">— Upload audit</span>
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Upload Audit Log
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Every upload, replacement and deletion against the private artist bucket, newest
          first — with the order reference, signed-in user and outcome.
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
            Action
          </span>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as (typeof ACTIONS)[number])}
            className="border border-border-strong bg-background/40 px-3 py-2 text-sm"
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a === "all" ? "All actions" : a}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Outcome
          </span>
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as (typeof OUTCOMES)[number])}
            className="border border-border-strong bg-background/40 px-3 py-2 text-sm"
          >
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o === "all" ? "All outcomes" : o}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Reference, file or path
          </span>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="HAR-1042"
            className="min-w-[12rem] border border-border-strong bg-background/40 px-3 py-2 text-sm"
          />
        </label>
        <Button type="submit" variant="outline" className="gap-2">
          <Search size={14} aria-hidden="true" /> Search
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          Refresh
        </Button>
      </form>

      {query.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading audit entries…
        </p>
      ) : query.error ? (
        <div role="alert" className="border border-destructive/40 bg-destructive/5 p-6 text-sm">
          {forbidden
            ? "Your account doesn't have staff access to the upload audit log."
            : `Couldn't load the audit log: ${String(query.error)}`}
        </div>
      ) : rows.length === 0 ? (
        <p className="flex items-center gap-2 border border-border-strong p-6 text-sm text-muted-foreground">
          <ShieldCheck size={15} aria-hidden="true" className="text-[#e11d2e]" />
          No file activity recorded for this filter yet.
        </p>
      ) : (
        <div className="overflow-x-auto border border-border-strong">
          <table className="w-full min-w-[860px] text-left text-sm">
            <caption className="sr-only">Upload, replace and delete activity</caption>
            <thead className="bg-card/50 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3">When</th>
                <th scope="col" className="px-4 py-3">Action</th>
                <th scope="col" className="px-4 py-3">Reference</th>
                <th scope="col" className="px-4 py-3">File</th>
                <th scope="col" className="px-4 py-3">Size</th>
                <th scope="col" className="px-4 py-3">User</th>
                <th scope="col" className="px-4 py-3">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border-strong/60 align-top">
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs uppercase">{row.action}</td>
                  <td className="px-4 py-3 font-mono text-xs">{row.reference_code ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className="block">{row.file_name ?? "—"}</span>
                    <span className="block break-all text-xs text-muted-foreground">
                      {row.object_path}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatSize(row.file_size)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {row.user_id ? `${row.user_id.slice(0, 8)}…` : "Guest"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        row.outcome === "failed"
                          ? "font-mono text-xs uppercase text-destructive"
                          : "font-mono text-xs uppercase text-emerald-400"
                      }
                    >
                      {row.outcome}
                    </span>
                    {row.error_message ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {row.error_message}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
