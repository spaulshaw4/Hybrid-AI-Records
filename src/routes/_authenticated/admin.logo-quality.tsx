import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ImageUp, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  analyzeLogoQuality,
  readImageDimensions,
  GRADE_LABEL,
  type LogoQualityReport,
  type QualityGrade,
} from "@/lib/logo-quality";

export const Route = createFileRoute("/_authenticated/admin/logo-quality")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/logo-quality",
      title: "Logo Resolution Checker — Hybrid AI Records",
      description:
        "Check a crest or logo file against every share-banner size and get warned before upscaling artifacts ship.",
      socialTitle: "Logo Resolution Checker — Hybrid AI Records",
      socialDescription: "Grade logo artwork against every share-banner size before it is composited.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminLogoQuality,
});

const GRADE_STYLES: Record<QualityGrade, { text: string; ring: string; Icon: typeof CheckCircle2 }> = {
  excellent: { text: "text-emerald-400", ring: "ring-emerald-500/40", Icon: CheckCircle2 },
  good: { text: "text-emerald-300", ring: "ring-emerald-400/30", Icon: CheckCircle2 },
  risky: { text: "text-amber-400", ring: "ring-amber-500/40", Icon: AlertTriangle },
  poor: { text: "text-[#e11d2e]", ring: "ring-[#e11d2e]/40", Icon: XCircle },
};

function AdminLogoQuality() {
  const [report, setReport] = useState<LogoQualityReport | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const { width, height } = await readImageDimensions(file);
      setReport(analyzeLogoQuality(width, height));
      setFileName(file.name);
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(file);
      });
    } catch (e) {
      setReport(null);
      setPreview(null);
      setError(e instanceof Error ? e.message : "Could not read that file.");
    }
  }

  const overall = report ? GRADE_STYLES[report.overall] : null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow">
          <span className="text-[#e11d2e]">/ Staff</span> <span className="text-white">— Artwork QA</span>
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Logo Resolution Checker
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Drop the crest file here before regenerating share banners. It grades the source against every
          banner box and warns when it would have to be enlarged — the cause of soft edges and halos.
        </p>
      </header>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFile(e.dataTransfer.files?.[0]);
        }}
        className={`rounded-2xl border border-dashed p-10 text-center transition-colors ${
          dragging ? "border-[#e11d2e] bg-[#e11d2e]/5" : "border-white/15 bg-white/[0.02]"
        }`}
      >
        <ImageUp className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm text-muted-foreground">
          Drag the logo here, or choose a file. Nothing is uploaded — it is measured in your browser.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        <Button type="button" variant="outline" className="mt-4" onClick={() => inputRef.current?.click()}>
          Choose logo file
        </Button>
      </div>

      {error ? <p className="mt-4 text-sm text-[#e11d2e]">{error}</p> : null}

      {report && overall ? (
        <section className="mt-8 space-y-6">
          <div className={`flex flex-wrap items-center gap-5 rounded-2xl bg-white/[0.03] p-5 ring-1 ${overall.ring}`}>
            {preview ? (
              <img
                src={preview}
                alt={`Preview of ${fileName ?? "the selected logo"}`}
                className="h-20 w-20 rounded-lg object-contain"
              />
            ) : null}
            <div className="min-w-[16rem] flex-1">
              <p className="truncate text-sm text-muted-foreground">{fileName}</p>
              <p className={`mt-1 flex items-center gap-2 font-display text-xl font-bold ${overall.text}`}>
                <overall.Icon className="h-5 w-5" aria-hidden />
                {GRADE_LABEL[report.overall]}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {report.width} × {report.height}px · {report.megapixels} MP · {report.aspectRatio}:1 ·
                needs {report.recommendedMinPx}px on the longest edge
              </p>
            </div>
          </div>

          {report.warnings.length > 0 ? (
            <ul className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
              {report.warnings.map((w) => (
                <li key={w} className="flex gap-3 text-sm text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 text-sm text-emerald-200">
              No upscaling needed — this file is large enough for every banner size.
            </p>
          )}

          <div className="overflow-hidden rounded-2xl ring-1 ring-white/10">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/[0.04] text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Banner</th>
                  <th className="px-4 py-3">Needs</th>
                  <th className="px-4 py-3">Scale</th>
                  <th className="px-4 py-3">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {report.verdicts.map((v) => {
                  const style = GRADE_STYLES[v.grade];
                  return (
                    <tr key={v.target.key} className="border-t border-white/5 align-top">
                      <td className="px-4 py-3 font-medium">{v.target.label}</td>
                      <td className="px-4 py-3 text-muted-foreground">{v.requiredPx}px</td>
                      <td className={`px-4 py-3 font-mono ${style.text}`}>{v.scale.toFixed(2)}×</td>
                      <td className="px-4 py-3">
                        <span className={`flex items-center gap-2 font-medium ${style.text}`}>
                          <style.Icon className="h-4 w-4 shrink-0" aria-hidden />
                          {GRADE_LABEL[v.grade]}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">{v.message}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </main>
  );
}
