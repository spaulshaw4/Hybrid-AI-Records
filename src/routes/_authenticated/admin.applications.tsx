import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AlertTriangle,
  Loader2,
  Percent,
  RefreshCw,
  Search,
  Languages,
  FileClock,
  LineChart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SecurityScanPanel } from "@/components/SecurityScanPanel";

import {
  listApplications,
  updateApplicationStatus,
  type AdminApplication,
} from "@/lib/admin-applications.functions";
import { TRACK_STATUS_STEPS, type TrackStatusKey } from "@/lib/track-requests.functions";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

export const Route = createFileRoute("/_authenticated/admin/applications")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/applications",
      title: "Applications Inbox — Hybrid AI Records",
      description: "Private staff inbox for reviewing artist project applications submitted to Hybrid AI Records.",
      socialTitle: "Applications Inbox — Hybrid AI Records",
      socialDescription: "Private staff inbox for artist project applications.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminApplications,
});

const STATUS_LABEL: Record<TrackStatusKey, string> = Object.fromEntries(
  TRACK_STATUS_STEPS.map((s) => [s.key, s.label]),
) as Record<TrackStatusKey, string>;

function AdminApplications() {
  const [status, setStatus] = useState<"all" | TrackStatusKey>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [openRef, setOpenRef] = useState<string | null>(null);

  const fetchApplications = useServerFn(listApplications);
  const saveStatus = useServerFn(updateApplicationStatus);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["admin-applications", status, search],
    queryFn: () => fetchApplications({ data: { status, search, limit: 100 } }),
  });

  const mutation = useMutation({
    mutationFn: (vars: { reference: string; status: TrackStatusKey; statusNote: string }) =>
      saveStatus({
        data: { reference: vars.reference, status: vars.status, statusNote: vars.statusNote },
      }),
    onSuccess: () => {
      toast.success("Application updated");
      void queryClient.invalidateQueries({ queryKey: ["admin-applications"] });
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Update failed"),
  });

  const applications = query.data?.applications ?? [];
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of applications) map.set(a.status, (map.get(a.status) ?? 0) + 1);
    return map;
  }, [applications]);

  const forbidden =
    query.isError && /forbidden/i.test((query.error as Error)?.message ?? "");

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow">
          <span className="text-[#e11d2e]">/ Staff</span>{" "}
          <span className="text-white">— Applications</span>
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Applications Inbox
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Every project application submitted through the site, newest first. Update a
          status and the artist sees it on their Order Status page.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            to="/admin/pricing"
            className="inline-flex items-center gap-2 border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <Percent size={13} aria-hidden="true" /> Processing surcharge settings
          </Link>
          <Link
            to="/admin/review"
            className="inline-flex items-center gap-2 border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <AlertTriangle size={13} aria-hidden="true" /> Payment review queue
          </Link>
          <Link
            to="/admin/translations"
            className="inline-flex items-center gap-2 border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <Languages size={13} aria-hidden="true" /> Translation panel
          </Link>
          <Link
            to="/admin/uploads"
            className="inline-flex items-center gap-2 border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <FileClock size={13} aria-hidden="true" /> Upload audit log
          </Link>
          <Link
            to="/admin/search-console"
            className="inline-flex items-center gap-2 border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <LineChart size={13} aria-hidden="true" /> Search Console dashboard
          </Link>
        </div>
      </header>

      <SecurityScanPanel />




      {forbidden ? (
        <div
          role="alert"
          className="border border-destructive/40 bg-destructive/5 p-6 text-sm text-muted-foreground"
        >
          <p className="font-semibold text-foreground">This inbox is staff-only.</p>
          <p className="mt-1">
            Your account doesn't have the admin or staff role yet. Ask the label owner to
            grant it, then reload this page.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap gap-2">
              {(["all", ...TRACK_STATUS_STEPS.map((s) => s.key)] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStatus(key as "all" | TrackStatusKey)}
                  aria-pressed={status === key}
                  className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] transition-colors ${
                    status === key
                      ? "bg-[#e11d2e] text-black"
                      : "border border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {key === "all" ? "All" : STATUS_LABEL[key as TrackStatusKey]}
                  {key !== "all" && counts.get(key) ? ` (${counts.get(key)})` : ""}
                </button>
              ))}
            </div>

            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(searchInput.trim());
              }}
            >
              <label className="sr-only" htmlFor="admin-search">
                Search applications
              </label>
              <div className="flex items-center gap-2 border border-border bg-background/40 px-3 py-2">
                <Search className="size-4 text-muted-foreground" aria-hidden="true" />
                <input
                  id="admin-search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Artist, email, reference…"
                  className="w-56 bg-transparent text-sm outline-none"
                />
              </div>
              <Button type="submit" size="sm">
                Search
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void query.refetch()}
                aria-label="Refresh applications"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
              </Button>
            </form>
          </div>

          {query.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading applications…
            </p>
          ) : query.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {(query.error as Error).message}
            </p>
          ) : applications.length === 0 ? (
            <p className="border border-border/60 bg-background/30 p-8 text-center text-sm text-muted-foreground">
              No applications match this filter yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/60 border border-border/60">
              {applications.map((app) => (
                <ApplicationRow
                  key={app.reference}
                  app={app}
                  expanded={openRef === app.reference}
                  onToggle={() =>
                    setOpenRef(openRef === app.reference ? null : app.reference)
                  }
                  onSave={(next, note) =>
                    mutation.mutate({
                      reference: app.reference,
                      status: next,
                      statusNote: note,
                    })
                  }
                  saving={mutation.isPending}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function ApplicationRow({
  app,
  expanded,
  onToggle,
  onSave,
  saving,
}: {
  app: AdminApplication;
  expanded: boolean;
  onToggle: () => void;
  onSave: (status: TrackStatusKey, note: string) => void;
  saving: boolean;
}) {
  const [status, setStatus] = useState<TrackStatusKey>(app.status);
  const [note, setNote] = useState(app.statusNote ?? "");

  return (
    <li className="bg-background/25">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-col gap-1 p-4 text-start transition-colors hover:bg-background/45 sm:flex-row sm:items-center sm:justify-between"
      >
        <span className="min-w-0">
          <span className="block truncate font-display text-base font-semibold text-foreground">
            {app.artist}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {app.email} · {app.packageLabel}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3 font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
          <span className="text-[#e11d2e]">{app.reference}</span>
          <span>{STATUS_LABEL[app.status]}</span>
          <span>{new Date(app.createdAt).toLocaleDateString()}</span>
        </span>
      </button>

      {expanded ? (
        <div className="space-y-4 border-t border-border/60 p-4 text-sm">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">File</dt>
              <dd className="break-words">{app.fileName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">Link</dt>
              <dd className="break-all">
                {app.link ? (
                  <a
                    className="text-[#4b8bff] underline underline-offset-2"
                    href={app.link}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {app.link}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">Notes</dt>
              <dd className="whitespace-pre-wrap break-words">{app.notes ?? "—"}</dd>
            </div>
          </dl>

          <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-1">
              <label
                className="text-xs uppercase tracking-wider text-muted-foreground"
                htmlFor={`status-${app.reference}`}
              >
                Status
              </label>
              <select
                id={`status-${app.reference}`}
                value={status}
                onChange={(e) => setStatus(e.target.value as TrackStatusKey)}
                className="border border-border bg-background/60 px-3 py-2 text-sm"
              >
                {TRACK_STATUS_STEPS.map((step) => (
                  <option key={step.key} value={step.key}>
                    {step.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label
                className="text-xs uppercase tracking-wider text-muted-foreground"
                htmlFor={`note-${app.reference}`}
              >
                Note to artist
              </label>
              <input
                id={`note-${app.reference}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional message shown on their status page"
                className="border border-border bg-background/60 px-3 py-2 text-sm"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => onSave(status, note)}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
