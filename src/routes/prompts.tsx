import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { SITE_URL } from "@/lib/release-schema";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

type PromptRecord = {
  id: number;
  prompt_id: string;
  camera_move: string;
  subject: string;
  environment: string;
  lighting: string;
  render: string;
  prompt: string;
};

/** The four tag fields every prompt is built from — each one is filterable. */
const TAG_FIELDS = [
  { key: "camera_move", label: "Camera move" },
  { key: "subject", label: "Subject" },
  { key: "environment", label: "Environment" },
  { key: "lighting", label: "Lighting" },
] as const;

type TagKey = (typeof TAG_FIELDS)[number]["key"];

const ANY = "__any__";
const PAGE_SIZE = 30;

export const Route = createFileRoute("/prompts")({
  errorComponent: RouteErrorFallback,
  head: () => ({
    meta: [
      { title: "Prompt Master Database — Hybrid AI Records" },
      {
        name: "description",
        content:
          "Browse and filter the 500-prompt cinematic Prompt Master Database by camera move, subject, environment and lighting, then copy any prompt.",
      },
      { property: "og:title", content: "Prompt Master Database — Hybrid AI Records" },
      {
        property: "og:description",
        content:
          "Searchable library of 500 style-locked cinematic shot prompts, filterable by tag field.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${SITE_URL}/prompts` },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/prompts` }],
  }),
  component: PromptsPage,
});

function PromptsPage() {
  const [records, setRecords] = useState<PromptRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<TagKey, string>>({
    camera_move: ANY,
    subject: ANY,
    environment: ANY,
    lighting: ANY,
  });
  const [visible, setVisible] = useState(PAGE_SIZE);

  // The database is a static export, so it is fetched once and filtered in
  // the browser — every keystroke stays instant with no round trips.
  useEffect(() => {
    let alive = true;
    fetch("/prompt-master-database.json")
      .then((res) => {
        if (!res.ok) throw new Error(`Couldn't load the prompt database (${res.status}).`);
        return res.json() as Promise<PromptRecord[]>;
      })
      .then((data) => {
        if (alive) setRecords(data);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : "Couldn't load the prompts.");
      });
    return () => {
      alive = false;
    };
  }, []);

  const options = useMemo(() => {
    const out = {} as Record<TagKey, string[]>;
    for (const field of TAG_FIELDS) {
      out[field.key] = Array.from(new Set((records ?? []).map((r) => r[field.key]))).sort((a, b) =>
        a.localeCompare(b),
      );
    }
    return out;
  }, [records]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (records ?? []).filter((record) => {
      for (const field of TAG_FIELDS) {
        const selected = filters[field.key];
        if (selected !== ANY && record[field.key] !== selected) return false;
      }
      if (!needle) return true;
      return (
        record.prompt.toLowerCase().includes(needle) ||
        record.prompt_id.toLowerCase().includes(needle)
      );
    });
  }, [records, filters, query]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [query, filters]);

  const activeCount =
    Object.values(filters).filter((value) => value !== ANY).length + (query.trim() ? 1 : 0);

  const resetAll = () => {
    setQuery("");
    setFilters({ camera_move: ANY, subject: ANY, environment: ANY, lighting: ANY });
  };

  const copyPrompt = async (record: PromptRecord) => {
    try {
      await navigator.clipboard.writeText(record.prompt);
      toast.success(`${record.prompt_id} copied.`);
    } catch {
      toast.error("Your browser blocked the clipboard. Select the text and copy manually.");
    }
  };

  const copyAllVisible = async () => {
    try {
      await navigator.clipboard.writeText(filtered.map((r) => r.prompt).join("\n\n"));
      toast.success(`${filtered.length} prompts copied.`);
    } catch {
      toast.error("Your browser blocked the clipboard.");
    }
  };

  return (
    <main className="min-h-dvh bg-background px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <PortalBreadcrumb />

        <header className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Prompt Master Database
          </h1>
          <p className="max-w-2xl text-muted-foreground">
            All 500 cinematic shot prompts from the master PDF, searchable and filterable by camera
            move, subject, environment and lighting. Copy any prompt straight into the Cinematic
            Studio.
          </p>
        </header>

        <Card>
          <CardContent className="space-y-5 pt-6">
            <div className="space-y-2">
              <Label htmlFor="prompt-search">Search prompt text</Label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="prompt-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="e.g. rain, Stetson, drone, PROMPT #0042"
                  className="pl-9"
                  aria-label="Search prompt text"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {TAG_FIELDS.map((field) => (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={`filter-${field.key}`}>{field.label}</Label>
                  <Select
                    value={filters[field.key]}
                    onValueChange={(value) =>
                      setFilters((prev) => ({ ...prev, [field.key]: value }))
                    }
                  >
                    <SelectTrigger id={`filter-${field.key}`} aria-label={field.label}>
                      <SelectValue placeholder={`Any ${field.label.toLowerCase()}`} />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={ANY}>Any {field.label.toLowerCase()}</SelectItem>
                      {options[field.key]?.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary">
                {records ? `${filtered.length} of ${records.length} prompts` : "Loading…"}
              </Badge>
              {activeCount > 0 && (
                <Button variant="ghost" size="sm" onClick={resetAll}>
                  <X className="size-4" aria-hidden="true" />
                  Clear filters
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyAllVisible()}
                disabled={filtered.length === 0}
                className="ml-auto"
              >
                <Copy className="size-4" aria-hidden="true" />
                Copy {filtered.length} results
              </Button>
            </div>
          </CardContent>
        </Card>

        {loadError && (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        )}

        {!records && !loadError && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading the prompt database…
          </div>
        )}

        {records && filtered.length === 0 && (
          <p className="text-muted-foreground">
            No prompts match those tags. Clear a filter to widen the search.
          </p>
        )}

        <ul className="space-y-4">
          {filtered.slice(0, visible).map((record) => (
            <li key={record.id}>
              <Card>
                <CardContent className="space-y-4 pt-6">
                  <div className="flex items-start justify-between gap-4">
                    <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                      {record.prompt_id}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyPrompt(record)}
                      aria-label={`Copy ${record.prompt_id}`}
                    >
                      <Copy className="size-4" aria-hidden="true" />
                      Copy
                    </Button>
                  </div>
                  <p className="text-[0.95rem] leading-relaxed">{record.prompt}</p>
                  <div className="flex flex-wrap gap-2">
                    {TAG_FIELDS.map((field) => (
                      <button
                        key={field.key}
                        type="button"
                        onClick={() =>
                          setFilters((prev) => ({ ...prev, [field.key]: record[field.key] }))
                        }
                        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        aria-label={`Filter by ${field.label}: ${record[field.key]}`}
                      >
                        <Badge variant="outline" className="cursor-pointer font-normal">
                          {record[field.key]}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>

        {filtered.length > visible && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => setVisible((v) => v + PAGE_SIZE)}>
              Show more ({filtered.length - visible} left)
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
