import { useMemo, useState } from "react";
import { pageHead } from "@/lib/social-meta";
import { devOnlyBeforeLoad } from "@/lib/dev-route-guard";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  cachedTranslationsFor,
  knownSourceStrings,
  visibleSourceStrings,
  type LanguageCode,
} from "@/lib/i18n";
import { getTranslationOverrides } from "@/lib/translation-overrides.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/**
 * Pre-publish translation audit.
 *
 * Copy on this site is translated at runtime from the English source strings
 * rendered in the DOM, so "coverage" means: for every English string this
 * browser has collected, does each language have a cached or admin-authored
 * translation, and is that translation actually different from the English?
 *
 * Internal tooling — noindex, no product content.
 */
export const Route = createFileRoute("/dev/translations")({
  beforeLoad: devOnlyBeforeLoad,
  head: () =>
    pageHead({
      path: "/dev/translations",
      title: "Translation Coverage Audit — Hybrid AI Records Internal",
      description: "Internal pre-publish check listing missing and untranslated copy for every language supported by Hybrid AI Records.",
      socialTitle: "Translation Coverage Audit — Hybrid AI Records Internal",
      socialDescription: "Internal pre-publish check for missing and untranslated site copy per language.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: TranslationAudit,
});

type Row = { source: string; state: "missing" | "untranslated" | "ok"; value: string };

type Report = {
  code: LanguageCode;
  label: string;
  flag: string;
  rows: Row[];
  missing: number;
  untranslated: number;
  ok: number;
};

const TRANSLATABLE = LANGUAGES.filter((l) => l.code !== DEFAULT_LANGUAGE);

function TranslationAudit() {
  const [sources, setSources] = useState<string[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [selected, setSelected] = useState<LanguageCode | null>(null);
  const [filter, setFilter] = useState<"problems" | "all">("problems");
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scannedAt, setScannedAt] = useState<string>("");

  async function scan() {
    setScanning(true);
    try {
      const collected = Array.from(
        new Set([...knownSourceStrings(), ...visibleSourceStrings()]),
      ).sort((a, b) => a.localeCompare(b));

      const next: Report[] = [];
      for (const lang of TRANSLATABLE) {
        const cache = cachedTranslationsFor(lang.code);
        try {
          const overrides = await getTranslationOverrides({ data: { language: lang.code } });
          for (const row of overrides) {
            if (row.sourceText && row.translatedText) cache.set(row.sourceText, row.translatedText);
          }
        } catch {
          /* offline — audit the local cache only */
        }
        const rows: Row[] = collected.map((source) => {
          const value = cache.get(source) ?? "";
          if (!value.trim()) return { source, state: "missing", value: "" };
          if (value.trim() === source.trim()) return { source, state: "untranslated", value };
          return { source, state: "ok", value };
        });
        next.push({
          code: lang.code,
          label: lang.label,
          flag: lang.flag ?? "",
          rows,
          missing: rows.filter((r) => r.state === "missing").length,
          untranslated: rows.filter((r) => r.state === "untranslated").length,
          ok: rows.filter((r) => r.state === "ok").length,
        });
      }

      setSources(collected);
      setReports(next);
      setSelected((prev) => prev ?? next[0]?.code ?? null);
      setScannedAt(new Date().toLocaleString());
    } finally {
      setScanning(false);
    }
  }

  const active = reports.find((r) => r.code === selected) ?? null;

  const visibleRows = useMemo(() => {
    if (!active) return [];
    const q = query.trim().toLowerCase();
    return active.rows.filter((row) => {
      if (filter === "problems" && row.state === "ok") return false;
      if (!q) return true;
      return row.source.toLowerCase().includes(q) || row.value.toLowerCase().includes(q);
    });
  }, [active, filter, query]);

  function copyGaps() {
    if (!active) return;
    const text = active.rows
      .filter((r) => r.state !== "ok")
      .map((r) => `${r.state.toUpperCase()}\t${r.source}`)
      .join("\n");
    void navigator.clipboard?.writeText(text);
  }

  return (
    <main className="min-h-dvh bg-background/40 text-foreground backdrop-blur-sm">
      <div className="mx-auto max-w-5xl px-4 py-10 space-y-8">
        <header className="space-y-3">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Internal tooling</p>
          <h1 className="text-3xl font-bold tracking-tight">Translation coverage audit</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Lists every English source string this browser has collected and flags the ones that are{" "}
            <strong>missing</strong> (no translation cached or authored) or{" "}
            <strong>untranslated</strong> (the translation is identical to the English) for each
            language. Visit the pages you are about to publish in each language first so their copy
            is collected, then run the scan.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void scan()} disabled={scanning}>
              {scanning ? "Scanning…" : "Run scan"}
            </Button>
            <Button asChild variant="outline">
              <Link to="/admin/translations">Open translation editor</Link>
            </Button>
            {scannedAt ? (
              <span className="text-xs text-muted-foreground">
                {sources.length} source strings · scanned {scannedAt}
              </span>
            ) : null}
          </div>
        </header>

        {reports.length === 0 ? (
          <p className="rounded-lg border border-border/60 bg-card/40 p-6 text-sm text-muted-foreground">
            No scan yet. Run the scan to see per-language gaps.
          </p>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {reports.map((report) => {
                const total = report.rows.length || 1;
                const pct = Math.round((report.ok / total) * 100);
                const isActive = report.code === selected;
                return (
                  <button
                    key={report.code}
                    type="button"
                    onClick={() => setSelected(report.code)}
                    className={`rounded-lg border p-4 text-start transition-colors ${
                      isActive
                        ? "border-primary bg-primary/10"
                        : "border-border/60 bg-card/40 hover:border-primary/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">
                        <span aria-hidden="true">{report.flag} </span>
                        {report.label}
                      </span>
                      <span className="text-sm text-muted-foreground">{pct}%</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <Badge variant={report.missing ? "destructive" : "secondary"}>
                        {report.missing} missing
                      </Badge>
                      <Badge variant={report.untranslated ? "destructive" : "secondary"}>
                        {report.untranslated} untranslated
                      </Badge>
                      <Badge variant="secondary">{report.ok} ok</Badge>
                    </div>
                  </button>
                );
              })}
            </section>

            {active ? (
              <section className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-semibold">
                    {active.flag} {active.label}
                  </h2>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={filter === "problems" ? "default" : "outline"}
                      onClick={() => setFilter("problems")}
                    >
                      Gaps only
                    </Button>
                    <Button
                      size="sm"
                      variant={filter === "all" ? "default" : "outline"}
                      onClick={() => setFilter("all")}
                    >
                      All strings
                    </Button>
                  </div>
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search copy…"
                    className="h-9 w-56"
                    aria-label="Search source strings"
                  />
                  <Button size="sm" variant="outline" onClick={copyGaps}>
                    Copy gaps
                  </Button>
                </div>

                {visibleRows.length === 0 ? (
                  <p className="rounded-lg border border-border/60 bg-card/40 p-6 text-sm text-muted-foreground">
                    Nothing to fix here — every collected string has a distinct translation.
                  </p>
                ) : (
                  <ul className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card/40">
                    {visibleRows.map((row) => (
                      <li key={row.source} className="flex flex-col gap-1 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-sm font-medium">{row.source}</p>
                          <Badge
                            variant={row.state === "ok" ? "secondary" : "destructive"}
                            className="shrink-0"
                          >
                            {row.state}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground" dir="auto">
                          {row.value || "— no translation —"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
