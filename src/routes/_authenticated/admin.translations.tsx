import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { settingsErrorMessage } from "@/lib/settings-error";
import { ArrowLeft, Languages, Loader2, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  LANGUAGES,
  invalidateTranslationOverrides,
  knownSourceStrings,
  visibleSourceStrings,
  type LanguageCode,
} from "@/lib/i18n";
import {
  deleteTranslationOverride,
  listTranslationOverrides,
  saveTranslationOverride,
} from "@/lib/translation-overrides.functions";

export const Route = createFileRoute("/_authenticated/admin/translations")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/translations",
      title: "Translation Panel — Hybrid AI Records",
      description: "Private admin panel for editing page copy in every supported language without a redeploy.",
      socialTitle: "Translation Panel — Hybrid AI Records",
      socialDescription: "Edit translated page copy for each supported language.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminTranslations,
});

const TRANSLATABLE = LANGUAGES.filter((l) => l.code !== "en");

function AdminTranslations() {
  const queryClient = useQueryClient();
  const load = useServerFn(listTranslationOverrides);
  const save = useServerFn(saveTranslationOverride);
  const remove = useServerFn(deleteTranslationOverride);

  const [language, setLanguage] = useState<LanguageCode>(TRANSLATABLE[0].code);
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newSource, setNewSource] = useState("");
  const [newTranslation, setNewTranslation] = useState("");

  const overridesQuery = useQuery({
    queryKey: ["translation-overrides", language],
    queryFn: () => load({ data: { language } }),
  });

  // The catalogue of English copy: everything already saved, plus strings this
  // browser has seen on the site (cached translations and the current page).
  const catalogue = useMemo(() => {
    const set = new Set<string>();
    for (const row of overridesQuery.data ?? []) set.add(row.sourceText);
    for (const s of knownSourceStrings()) set.add(s);
    for (const s of visibleSourceStrings()) set.add(s);
    const term = search.trim().toLowerCase();
    return Array.from(set)
      .filter((s) => !term || s.toLowerCase().includes(term))
      .sort((a, b) => a.localeCompare(b));
  }, [overridesQuery.data, search]);

  const savedMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of overridesQuery.data ?? []) map.set(row.sourceText, row.translatedText);
    return map;
  }, [overridesQuery.data]);

  const refresh = () => {
    invalidateTranslationOverrides(language);
    void queryClient.invalidateQueries({ queryKey: ["translation-overrides", language] });
  };

  const saveMutation = useMutation({
    mutationFn: (vars: { sourceText: string; translatedText: string }) =>
      save({ data: { language, ...vars } }),
    onSuccess: (_data, vars) => {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[vars.sourceText];
        return next;
      });
      toast.success("Translation saved — live for visitors now.");
      refresh();
    },
    onError: (err: Error) => toast.error(err.message || "Could not save that translation."),
  });

  const deleteMutation = useMutation({
    mutationFn: (sourceText: string) => remove({ data: { language, sourceText } }),
    onSuccess: () => {
      toast.success("Reverted to the automatic translation.");
      refresh();
    },
    onError: (err: Error) => toast.error(err.message || "Could not remove that translation."),
  });

  const busySource = saveMutation.isPending ? saveMutation.variables?.sourceText : null;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            to="/admin/applications"
            className="mb-3 inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft size={13} aria-hidden="true" /> Applications inbox
          </Link>
          <h1 className="flex items-center gap-3 text-2xl font-black uppercase tracking-tight text-foreground">
            <Languages size={22} aria-hidden="true" className="text-primary" />
            Translation panel
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Edit how page copy reads in each language. Saved wording replaces the automatic
            translation for every visitor immediately — no redeploy needed.
          </p>
        </div>
        <Button variant="outline" onClick={refresh} className="gap-2">
          <RotateCcw size={14} aria-hidden="true" /> Refresh
        </Button>
      </header>

      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Language">
        {TRANSLATABLE.map((l) => (
          <button
            key={l.code}
            type="button"
            onClick={() => {
              try {
                setLanguage(l.code);
              } catch (error) {
                toast.error("Couldn't change language", {
                  description: settingsErrorMessage(error),
                });
              }
            }}
            aria-pressed={language === l.code}
            className={`inline-flex items-center gap-2 border px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors ${
              language === l.code
                ? "border-primary bg-primary/10 text-primary"
                : "border-border-strong text-muted-foreground hover:border-primary hover:text-primary"
            }`}
          >
            <span aria-hidden="true">{l.flag}</span> {l.native}
          </button>
        ))}
      </div>

      {/* Add any string manually, e.g. copy that lives on a page you're not on. */}
      <section className="mb-8 border border-border-strong p-4">
        <h2 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground">
          Add a phrase
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">English copy (exact)</span>
            <textarea
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              rows={2}
              className="w-full border border-border-strong bg-background p-2 text-sm text-foreground"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">Translation</span>
            <textarea
              value={newTranslation}
              onChange={(e) => setNewTranslation(e.target.value)}
              rows={2}
              className="w-full border border-border-strong bg-background p-2 text-sm text-foreground"
            />
          </label>
        </div>
        <Button
          className="mt-3 gap-2"
          disabled={!newSource.trim() || !newTranslation.trim() || saveMutation.isPending}
          onClick={() =>
            saveMutation.mutate(
              { sourceText: newSource.trim(), translatedText: newTranslation.trim() },
              {
                onSuccess: () => {
                  setNewSource("");
                  setNewTranslation("");
                },
              },
            )
          }
        >
          <Plus size={14} aria-hidden="true" /> Save phrase
        </Button>
      </section>

      <label className="mb-4 block">
        <span className="sr-only">Search page copy</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search page copy…"
          className="w-full border border-border-strong bg-background px-3 py-2 text-sm text-foreground"
        />
      </label>

      {overridesQuery.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading translations…
        </p>
      ) : catalogue.length === 0 ? (
        <p className="border border-border-strong p-4 text-sm text-muted-foreground">
          No copy collected yet. Visit the site in this browser (or switch a page to this language
          once) and the phrases will appear here — or add one manually above.
        </p>
      ) : (
        <ul className="space-y-3">
          {catalogue.map((source) => {
            const saved = savedMap.get(source) ?? "";
            const value = drafts[source] ?? saved;
            const dirty = value.trim() !== saved.trim();
            return (
              <li key={source} className="border border-border-strong p-4">
                <p className="mb-2 text-sm font-semibold text-foreground">{source}</p>
                <textarea
                  value={value}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [source]: e.target.value }))}
                  rows={2}
                  placeholder="Automatic translation in use — type to override"
                  className="w-full border border-border-strong bg-background p-2 text-sm text-foreground"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className="gap-2"
                    disabled={!dirty || !value.trim() || busySource === source}
                    onClick={() =>
                      saveMutation.mutate({ sourceText: source, translatedText: value.trim() })
                    }
                  >
                    {busySource === source ? (
                      <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Save size={13} aria-hidden="true" />
                    )}
                    Save
                  </Button>
                  {saved ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate(source)}
                    >
                      <Trash2 size={13} aria-hidden="true" /> Revert to automatic
                    </Button>
                  ) : (
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      Automatic
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
