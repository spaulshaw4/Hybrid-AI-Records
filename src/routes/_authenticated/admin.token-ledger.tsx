import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Coins, Filter, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listTokenAudit, type TokenLedgerRow } from "@/lib/admin-tokens.functions";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

export const Route = createFileRoute("/_authenticated/admin/token-ledger")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/token-ledger",
      title: "Token Ledger — Hybrid AI Records",
      description:
        "Private admin ledger of every Hybrid Token credit, refund and adjustment with filters.",
      socialTitle: "Token Ledger — Hybrid AI Records",
      socialDescription: "Private admin ledger of Hybrid Token credits and refunds.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminTokenLedger,
});

const inputClass =
  "w-full rounded-md border border-white/10 bg-ink/40 px-3 py-2 text-sm outline-none focus:border-[#e11d2e]";

type Filters = {
  email: string;
  reason: string;
  minAmount: string;
  maxAmount: string;
  from: string;
  to: string;
};

const EMPTY: Filters = { email: "", reason: "", minAmount: "", maxAmount: "", from: "", to: "" };

function AdminTokenLedger() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [entries, setEntries] = useState<TokenLedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listFn = useServerFn(listTokenAudit);

  const search = useMutation({
    mutationFn: (f: Filters) =>
      listFn({
        data: {
          email: f.email.trim() || undefined,
          reason: f.reason.trim() || undefined,
          minAmount: f.minAmount ? Number(f.minAmount) : undefined,
          maxAmount: f.maxAmount ? Number(f.maxAmount) : undefined,
          from: f.from || undefined,
          to: f.to || undefined,
          limit: 200,
        },
      }),
    onSuccess: (res) => {
      setEntries(res.entries);
      setError(null);
    },
    onError: (err) => {
      setEntries(null);
      setError(
        /forbidden|unauthorized/i.test(String(err)) ? "Admin access required." : String(err),
      );
    },
  });

  const set = (key: keyof Filters) => (value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const total = (entries ?? []).reduce((sum, e) => sum + e.amount, 0);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow">
          <span className="text-[#e11d2e]">/ Admin</span>{" "}
          <span className="text-white">— Token ledger</span>
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Hybrid Token Ledger
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every admin credit and refund written to the audit log. Filter by artist email,
          reason, amount or date range.{" "}
          <Link to="/admin/tokens" className="text-[#d4af37] underline-offset-4 hover:underline">
            Credit or refund tokens
          </Link>
          .
        </p>
      </header>

      <form
        className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          search.mutate(filters);
        }}
      >
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">Artist email</span>
          <input
            value={filters.email}
            onChange={(e) => set("email")(e.target.value)}
            placeholder="artist@example.com"
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">Reason contains</span>
          <input
            value={filters.reason}
            onChange={(e) => set("reason")(e.target.value)}
            placeholder="refund"
            className={inputClass}
          />
        </label>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label>
            <span className="mb-1 block text-xs text-muted-foreground">Min tokens</span>
            <input
              type="number"
              value={filters.minAmount}
              onChange={(e) => set("minAmount")(e.target.value)}
              className={inputClass}
            />
          </label>
          <label>
            <span className="mb-1 block text-xs text-muted-foreground">Max tokens</span>
            <input
              type="number"
              value={filters.maxAmount}
              onChange={(e) => set("maxAmount")(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">From date</span>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => set("from")(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">To date</span>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => set("to")(e.target.value)}
            className={inputClass}
          />
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={search.isPending}>
            {search.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Filter className="mr-2 h-4 w-4" />
            )}
            Apply filters
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setFilters(EMPTY);
              search.mutate(EMPTY);
            }}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>
      </form>

      {error ? (
        <p className="mt-6 rounded-md border border-[#e11d2e]/40 bg-[#e11d2e]/10 px-4 py-3 text-sm text-[#ffb4bc]">
          {error}
        </p>
      ) : null}

      {entries ? (
        <section className="mt-8">
          <p className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <Coins className="h-4 w-4 text-[#d4af37]" />
            {entries.length} entr{entries.length === 1 ? "y" : "ies"} · {total} tokens credited
          </p>
          {entries.length === 0 ? (
            <p className="rounded-md border border-white/10 bg-white/5 px-4 py-3 text-sm text-muted-foreground">
              No ledger entries match those filters.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-white/[0.04] text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Artist</th>
                    <th className="px-4 py-3">Tokens</th>
                    <th className="px-4 py-3">Reason</th>
                    <th className="px-4 py-3">Balance after</th>
                    <th className="px-4 py-3">By</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-t border-white/5">
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">{entry.email ?? entry.userId}</td>
                      <td className="px-4 py-3 font-semibold text-[#d4af37]">+{entry.amount}</td>
                      <td className="px-4 py-3 text-muted-foreground">{entry.reason ?? "—"}</td>
                      <td className="px-4 py-3">{entry.balanceAfter ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {entry.adminEmail ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}
