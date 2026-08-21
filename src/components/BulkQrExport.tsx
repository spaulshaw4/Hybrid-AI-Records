import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { ORDER_PACKAGES, PACKAGE_SLUGS, orderUrl, type OrderPackage } from "@/lib/order-link";
import QrManifestVerifier from "@/components/QrManifestVerifier";


/** Every share link the label hands out, in one bulk-selectable list. */
type BulkTarget = { id: string; label: string; pkg: OrderPackage | null };

const TARGETS: BulkTarget[] = [
  { id: "general", label: "General order form", pkg: null },
  ...ORDER_PACKAGES.map((pkg) => ({ id: PACKAGE_SLUGS[pkg], label: pkg, pkg })),
];

const BRAND = {
  label: "HYBRID AI RECORDS",
  tagline: "Independent releases, engineered end to end.",
  footer: "hybrid-ai-records.com — Steven P. Shaw and the Hybrid team",
  ink: "#16181d",
  accent: "#c81e33",
};

const QR_PX = 1024;

/** Decodes base64 image data into raw bytes for hashing. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** SHA-256 checksum so extracted files can be verified against the manifest. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return "unavailable";
  try {
    const digest = await subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "unavailable";
  }
}


const PNG_SIZES = [512, 1024, 2048, 4096] as const;

const QR_MARGINS: { value: number; label: string }[] = [
  { value: 0, label: "None" },
  { value: 2, label: "Standard (2)" },
  { value: 4, label: "Wide (4)" },
];

const PNG_BACKGROUNDS: { value: string; label: string }[] = [
  { value: "#ffffff", label: "White" },
  { value: "#f5f5f5", label: "Off-white" },
  { value: "#111111", label: "Charcoal" },
  { value: "transparent", label: "Transparent" },
];


/** Configurable PDF layout options for the bulk export. */
const PDF_SIZES = [
  { id: "letter", label: "Letter" },
  { id: "a4", label: "A4" },
] as const;
type PdfSize = (typeof PDF_SIZES)[number]["id"];

const PDF_ORIENTATIONS = [
  { id: "portrait", label: "Portrait" },
  { id: "landscape", label: "Landscape" },
] as const;
type PdfOrientation = (typeof PDF_ORIENTATIONS)[number]["id"];

const PDF_MARGINS = [
  { id: "compact", label: "Compact", mm: 8 },
  { id: "standard", label: "Standard", mm: 14 },
  { id: "wide", label: "Wide", mm: 24 },
] as const;
type PdfMargin = (typeof PDF_MARGINS)[number]["id"];

const BRAND_PLACEMENTS = [
  { id: "both", label: "Header + footer" },
  { id: "header", label: "Header only" },
  { id: "footer", label: "Footer only" },
  { id: "none", label: "No branding" },
] as const;
type BrandPlacement = (typeof BRAND_PLACEMENTS)[number]["id"];

/**
 * Bulk QR generator: pick any combination of share links and export them all at
 * once — a single multi-page print-ready PDF (one QR per page) or one PNG per
 * selected link.
 */
/** One row of the live checksum feed shown while a ZIP export runs. */
type ChecksumCheck = {
  key: string;
  fileName: string;
  format: "PNG" | "SVG";
  label: string;
  bytes: number;
  sha256: string;
  state: "hashing" | "verifying" | "verified" | "failed";
  detail?: string;
};

/** Local-storage key + shape used to recover bulk export progress after a refresh. */
const PROGRESS_KEY = "hybrid-ai-records:bulk-qr-progress";
const PROGRESS_MAX_AGE_MS = 30 * 60 * 1000;

type ProgressSnapshot = {
  kind: "pdf" | "png" | "preview" | "csv" | "json";
  status: string;
  progress: { done: number; total: number };
  eta: string | null;
  zipPct: number | null;
  failures: { id: string; label: string; reason: string }[];
  savedAt: number;
};

function readProgressSnapshot(): ProgressSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProgressSnapshot;
    if (!parsed?.progress || Date.now() - (parsed.savedAt ?? 0) > PROGRESS_MAX_AGE_MS) {
      window.localStorage.removeItem(PROGRESS_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function BulkQrExport() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(TARGETS.map((t) => t.id));
  const [busy, setBusy] = useState<"pdf" | "png" | "preview" | "csv" | "json" | null>(null);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [pdfSize, setPdfSize] = useState<PdfSize>("letter");
  const [pdfOrientation, setPdfOrientation] = useState<PdfOrientation>("portrait");
  const [pdfMargin, setPdfMargin] = useState<PdfMargin>("standard");
  const [brandPlacement, setBrandPlacement] = useState<BrandPlacement>("both");
  const [pngSize, setPngSize] = useState<number>(QR_PX);
  const [qrMargin, setQrMargin] = useState<number>(2);
  const [pngBg, setPngBg] = useState<string>("#ffffff");
  const [includeSvg, setIncludeSvg] = useState(false);
  const [customLabels, setCustomLabels] = useState<Record<string, string>>({});
  const [campaign, setCampaign] = useState("");
  const [notes, setNotes] = useState("");


  const [preview, setPreview] = useState<{ url: string; pages: number } | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [thumbs, setThumbs] = useState<{ id: string; label: string; src: string }[]>([]);
  const [svgPreviews, setSvgPreviews] = useState<
    { id: string; label: string; src: string; width: string; height: string; viewBox: string; bytes: number }[]
  >([]);

  const [manifestPreview, setManifestPreview] = useState<string[][] | null>(null);
  const [failures, setFailures] = useState<{ id: string; label: string; reason: string }[]>([]);
  const [eta, setEta] = useState<string | null>(null);
  const [zipPct, setZipPct] = useState<number | null>(null);
  // Live per-file integrity feed: hash on generate, then re-hash the queued
  // ZIP entry and compare, so integrity is confirmed before the download.
  const [checks, setChecks] = useState<ChecksumCheck[]>([]);
  // Holds the finished archive. The "Download ZIP" button only enables once
  // this is set, so nobody can grab a half-built pack.
  const [zipReady, setZipReady] = useState<
    { url: string; fileName: string; count: number; bytes: number } | null
  >(null);

  /** Frees the object URL for a previously prepared ZIP. */
  const discardReadyZip = () => {
    setZipReady((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  // Never leak the blob URL if the panel unmounts with a ZIP still held.
  useEffect(() => () => discardReadyZip(), []);


  const startedAtRef = useRef(0);
  const cancelRef = useRef(false);
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const svgRefs = useRef<Record<string, SVGSVGElement | null>>({});
  const [recovered, setRecovered] = useState<ProgressSnapshot | null>(null);

  // Restore the last in-flight export snapshot so a refresh mid-export still
  // shows how far it had got (the work itself has to be re-run).
  useEffect(() => {
    const snap = readProgressSnapshot();
    if (!snap) return;
    setRecovered(snap);
    setProgress(snap.progress);
    setEta(snap.eta);
    setZipPct(snap.zipPct);
    setFailures(snap.failures ?? []);
    setStatus(
      `Recovered progress from an interrupted export (${snap.progress.done}/${snap.progress.total}). Run it again to finish.`,
    );
    setOpen(true);
  }, []);

  // Persist progress on every tick so the bar can be rebuilt after a refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!busy) return;
    const snapshot: ProgressSnapshot = {
      kind: busy,
      status,
      progress,
      eta,
      zipPct,
      failures,
      savedAt: Date.now(),
    };
    try {
      window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(snapshot));
    } catch {
      /* storage full or blocked — progress recovery is best-effort */
    }
  }, [busy, status, progress, eta, zipPct, failures]);

  /** Clears the saved snapshot once an export settles (done or cancelled). */
  const clearProgressSnapshot = () => {
    setRecovered(null);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(PROGRESS_KEY);
    } catch {
      /* ignore */
    }
  };



  /** Human-friendly remaining time from elapsed work so far. */
  const trackEta = (done: number, total: number) => {
    if (!done || done >= total) return setEta(done >= total ? "Finishing up…" : null);
    const elapsed = performance.now() - startedAtRef.current;
    const remaining = Math.round((elapsed / done) * (total - done) / 1000);
    setEta(
      remaining <= 1
        ? "About a second left"
        : remaining < 60
          ? `About ${remaining}s left`
          : `About ${Math.ceil(remaining / 60)} min left`,
    );
  };



  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const links = useMemo(
    () =>
      TARGETS.map((target) => ({
        ...target,
        packageName: target.pkg ?? "General order form",
        url: `${origin}${orderUrl(target.pkg)}`,
      })),
    [origin],
  );


  const chosen = links.filter((link) => selected.includes(link.id));

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** Copies a QR canvas onto the chosen backdrop (white for print, or transparent). */
  function flatten(canvas: HTMLCanvasElement, bg: string = pngBg): HTMLCanvasElement | null {
    const flat = document.createElement("canvas");
    flat.width = canvas.width;
    flat.height = canvas.height;
    const ctx = flat.getContext("2d");
    if (!ctx) return null;
    if (bg !== "transparent") {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, flat.width, flat.height);
    }
    ctx.drawImage(canvas, 0, 0);
    return flat;
  }

  /**
   * Serializes an off-screen QR SVG with the same pixel size, margin and
   * background as the PNG export, so both formats look identical.
   */
  function serializeSvg(svg: SVGSVGElement | null): string | null {
    return serializeSvgWithMeta(svg)?.text ?? null;
  }

  /** Same as serializeSvg but also reports the emitted width/height/viewBox. */
  function serializeSvgWithMeta(
    svg: SVGSVGElement | null,
  ): { text: string; width: string; height: string; viewBox: string } | null {
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(pngSize));
    clone.setAttribute("height", String(pngSize));
    if (!clone.getAttribute("viewBox")) {
      clone.setAttribute("viewBox", `0 0 ${pngSize} ${pngSize}`);
    }
    clone.setAttribute("shape-rendering", "crispEdges");
    if (pngBg !== "transparent") {
      clone.style.background = pngBg;
    }
    return {
      text: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`,
      width: String(pngSize),
      height: String(pngSize),
      viewBox: clone.getAttribute("viewBox") ?? "",
    };
  }



  /**
   * Requests cancellation of the running export. Loops check `cancelRef`
   * between files, and the ZIP/PDF paths discard whatever was built so far.
   */
  const cancelExport = () => {
    if (cancelRef.current) return;
    cancelRef.current = true;
    setEta(null);
    setZipPct(null);
    setStatus("Cancelling the export — discarding partial files…");
  };


  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** Builds the branded multi-page doc shared by preview and download. */
  async function buildPdfDoc() {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "mm", format: pdfSize, orientation: pdfOrientation });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = PDF_MARGINS.find((m) => m.id === pdfMargin)?.mm ?? 14;
    const showHeader = brandPlacement === "both" || brandPlacement === "header";
    const showFooter = brandPlacement === "both" || brandPlacement === "footer";
    let pages = 0;


      for (const link of chosen) {
        if (cancelRef.current) break;
        const canvas = canvasRefs.current[link.id];
        const flat = canvas ? flatten(canvas, pngBg === "#111111" ? "#111111" : "#ffffff") : null;

        if (!flat) continue;
        if (pages > 0) doc.addPage();
        pages += 1;

        const headerH = showHeader ? 26 : 0;
        if (showHeader) {
          doc.setFillColor(BRAND.ink);
          doc.rect(0, 0, pageW, headerH, "F");
          doc.setFillColor(BRAND.accent);
          doc.rect(0, headerH, pageW, 1.6, "F");
          doc.setTextColor("#ffffff");
          doc.setFont("helvetica", "bold");
          doc.setFontSize(13);
          doc.text(BRAND.label, margin, headerH / 2, { baseline: "middle" });
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor("#c9ccd2");
          doc.text(BRAND.tagline, pageW - margin, headerH / 2, {
            align: "right",
            baseline: "middle",
          });
        }

        const contentTop = headerH + margin + 6;
        doc.setTextColor(BRAND.ink);
        doc.setFont("courier", "bold");
        doc.setFontSize(16);
        doc.text(link.label.toUpperCase(), pageW / 2, contentTop, { align: "center" });
        doc.setFont("courier", "normal");
        doc.setFontSize(10);
        doc.text(`Page ${pages} of ${chosen.length}`, pageW / 2, contentTop + 8, {
          align: "center",
        });

        const qrTop = contentTop + 20;
        const bottomReserve = (showFooter ? 20 : margin) + 40;
        const qrMm = Math.max(
          40,
          Math.min(pageW - margin * 2, pageH - qrTop - bottomReserve),
        );
        doc.addImage(flat.toDataURL("image/png"), "PNG", (pageW - qrMm) / 2, qrTop, qrMm, qrMm);

        doc.setFontSize(11);
        doc.text("Scan to open this order form", pageW / 2, qrTop + qrMm + 14, { align: "center" });
        doc.setFontSize(9);
        const urlLines = doc.splitTextToSize(link.url, pageW - margin * 2 - 12) as string[];
        doc.text(urlLines, pageW / 2, qrTop + qrMm + 22, { align: "center" });

        if (showFooter) {
          doc.setFillColor(BRAND.accent);
          doc.rect(margin, pageH - margin - 6, pageW - margin * 2, 0.8, "F");
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor("#5a606b");
          doc.text(BRAND.footer, margin, pageH - margin);
          doc.text(new Date().getFullYear().toString(), pageW - margin, pageH - margin, {
            align: "right",
          });
        }
        setProgress({ done: pages, total: chosen.length });
        trackEta(pages, chosen.length);
        await tick();
    }

    return { doc, pages };
  }

  async function downloadPdf() {
    if (!chosen.length) return;
    cancelRef.current = false;
    setBusy("pdf");
    setProgress({ done: 0, total: chosen.length });
    startedAtRef.current = performance.now();
    setEta(null);
    setZipPct(null);
    setStatus("Building the bulk QR PDF…");
    try {
      const { doc, pages } = await buildPdfDoc();

      if (cancelRef.current) {
        setStatus("Bulk PDF export cancelled. Nothing was downloaded.");
        toast("Bulk QR export cancelled");
        return;
      }

      if (!pages) throw new Error("no QR codes ready");
      const fileName = `hybrid-ai-records-qr-pack-${pages}-links.pdf`;
      doc.save(fileName);
      setStatus(`Downloaded ${fileName} with ${pages} QR page${pages === 1 ? "" : "s"}.`);
      toast.success(`QR pack ready — ${pages} page${pages === 1 ? "" : "s"}`);
    } catch {
      setStatus("The bulk PDF couldn't be built. Try again in a moment.");
      toast.error("Couldn't build the bulk QR PDF", {
        description: "Give the codes a second to render, then try again.",
      });
    } finally {
      setBusy(null);
      clearProgressSnapshot();
      setProgress({ done: 0, total: 0 });
      setEta(null);
      setZipPct(null);
      cancelRef.current = false;
    }
  }

  /** Renders the same doc into an in-page paginated preview. */
  async function previewPdf() {
    if (!chosen.length) return;
    cancelRef.current = false;
    setBusy("preview");
    setProgress({ done: 0, total: chosen.length });
    startedAtRef.current = performance.now();
    setEta(null);
    setZipPct(null);
    setStatus("Rendering the PDF preview…");
    try {
      const { doc, pages } = await buildPdfDoc();
      if (cancelRef.current || !pages) {
        setStatus("Preview cancelled.");
        return;
      }
      const blob = doc.output("blob") as Blob;
      setPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url: URL.createObjectURL(blob), pages };
      });
      setPreviewPage(1);
      setStatus(`Preview ready with ${pages} page${pages === 1 ? "" : "s"}.`);
    } catch {
      setStatus("The preview couldn't be rendered. Try again in a moment.");
      toast.error("Couldn't render the PDF preview");
    } finally {
      setBusy(null);
      clearProgressSnapshot();
      setProgress({ done: 0, total: 0 });
      setEta(null);
      setZipPct(null);
      cancelRef.current = false;
    }
  }

  function closePreview() {
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }

  /** Builds the PNG thumbnail grid from the off-screen QR canvases. */
  function refreshThumbs() {
    const next = chosen
      .map((link) => {
        const canvas = canvasRefs.current[link.id];
        const flat = canvas ? flatten(canvas) : null;
        return flat ? { id: link.id, label: link.label, src: flat.toDataURL("image/png") } : null;
      })
      .filter((t): t is { id: string; label: string; src: string } => t !== null);
    setThumbs(next);
    setStatus(`Showing ${next.length} PNG preview${next.length === 1 ? "" : "s"}.`);
  }

  /** Builds the in-panel vector preview grid from the off-screen QR SVGs. */
  function refreshSvgPreviews() {
    const next = chosen
      .map((link) => {
        const svg = serializeSvgWithMeta(svgRefs.current[link.id]);
        if (!svg) return null;
        const bytes = new TextEncoder().encode(svg.text);
        const base64 = btoa(String.fromCharCode(...Array.from(bytes)));
        return {
          id: link.id,
          label: link.label,
          src: `data:image/svg+xml;base64,${base64}`,
          width: svg.width,
          height: svg.height,
          viewBox: svg.viewBox,
          bytes: bytes.length,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    setSvgPreviews(next);
    setStatus(`Showing ${next.length} SVG preview${next.length === 1 ? "" : "s"}.`);
  }





  /** Shared manifest column order for both the ZIP copy and the standalone CSV. */
  const manifestHeader = [
    "filename",
    "format",
    "package_name",
    "label",
    "custom_label",
    "campaign",
    "notes",
    "share_url",
    "package_slug",
    "size_px",
    "svg_width",
    "svg_height",
    "svg_viewbox",
    "background",
    "qr_margin",

    "fileSizeBytes",
    "sha256",

    "generated_at",
  ];

  function toCsv(rows: string[][]) {
    return rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\r\n");
  }

  function saveBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Builds the manifest rows (and hashes) for the currently selected links. */
  async function buildManifestRows(): Promise<string[][]> {
    const generatedAt = new Date().toISOString();
    const rows: string[][] = [manifestHeader];
    for (const link of chosen) {
      const canvas = canvasRefs.current[link.id];
      const flat = canvas ? flatten(canvas) : null;
      const base64 = flat ? flat.toDataURL("image/png").split(",")[1] : null;
      if (!base64) continue;
      const rowFor = (
        fileName: string,
        format: string,
        size: string,
        bytes: Uint8Array,
        sha256: string,
        svgMeta?: { width: string; height: string; viewBox: string },
      ) => [
        fileName,
        format,
        link.packageName,
        link.label,
        (customLabels[link.id] ?? "").trim(),
        campaign.trim(),
        notes.trim(),
        link.url,
        link.id,
        size,
        svgMeta?.width ?? "",
        svgMeta?.height ?? "",
        svgMeta?.viewBox ?? "",
        pngBg,
        String(qrMargin),
        String(bytes.byteLength),
        sha256,
        generatedAt,
      ];
      const pngBytes = base64ToBytes(base64);
      rows.push(
        rowFor(
          `png/hybrid-ai-records-qr-${link.id}-${pngSize}px.png`,
          "PNG",
          String(pngSize),
          pngBytes,
          await sha256Hex(pngBytes),
        ),
      );
      if (includeSvg) {
        const svg = serializeSvgWithMeta(svgRefs.current[link.id]);
        if (svg) {
          const svgBytes = new TextEncoder().encode(svg.text);
          rows.push(
            rowFor(
              `svg/hybrid-ai-records-qr-${link.id}-${pngSize}px.svg`,
              "SVG",
              String(pngSize),
              svgBytes,
              await sha256Hex(svgBytes),
              svg,
            ),
          );
        }
      }



      await tick();
    }
    return rows;
  }

  /** Converts manifest rows into a structured JSON document for programmatic checks. */
  function toManifestJson(rows: string[][]) {
    const [header = [], ...body] = rows;
    const files = body.map((row) =>
      Object.fromEntries(
        header.map((key, i) => {
          const value = row[i] ?? "";
          if (key === "size_px" || key === "qr_margin" || key === "fileSizeBytes")
            return [key, value === "" ? null : Number(value)];

          return [key, value];
        }),
      ),
    );
    return `${JSON.stringify(
      {
        schema: "hybrid-ai-records/qr-manifest@1",
        generator: "Hybrid AI Records bulk QR export",
        generated_at: files[0]?.["generated_at"] ?? new Date().toISOString(),
        campaign: campaign.trim() || null,
        notes: notes.trim() || null,
        hash_algorithm: "sha256",
        file_count: files.length,
        files,
      },
      null,
      2,
    )}\n`;
  }

  /** Downloads only qr-manifest.json, no ZIP. */
  async function downloadManifestJson() {
    if (!chosen.length) return;
    setBusy("json");
    setProgress({ done: 0, total: chosen.length });
    setStatus("Building qr-manifest.json…");
    try {
      const rows = await buildManifestRows();
      if (rows.length < 2) throw new Error("no QR codes ready");
      saveBlob(
        new Blob([toManifestJson(rows)], { type: "application/json;charset=utf-8" }),
        `hybrid-ai-records-qr-manifest-${chosen.length}-links.json`,
      );
      setStatus(`Downloaded qr-manifest.json with ${rows.length - 1} entr${rows.length === 2 ? "y" : "ies"}.`);
      toast.success("Manifest JSON downloaded");
    } catch {
      setStatus("The manifest JSON couldn't be built. Try again in a moment.");
      toast.error("Couldn't build the manifest JSON");
    } finally {
      setBusy(null);
      clearProgressSnapshot();
      setProgress({ done: 0, total: 0 });
    }
  }

  /** Downloads only qr-manifest.csv, no ZIP. */

  async function downloadManifestCsv() {
    if (!chosen.length) return;
    setBusy("csv");
    setProgress({ done: 0, total: chosen.length });
    setStatus("Building qr-manifest.csv…");
    try {
      const rows = await buildManifestRows();
      if (rows.length < 2) throw new Error("no QR codes ready");
      saveBlob(
        new Blob([`\uFEFF${toCsv(rows)}\r\n`], { type: "text/csv;charset=utf-8" }),
        `hybrid-ai-records-qr-manifest-${chosen.length}-links.csv`,
      );
      setStatus(`Downloaded qr-manifest.csv with ${rows.length - 1} row${rows.length === 2 ? "" : "s"}.`);
      toast.success("Manifest CSV downloaded");
    } catch {
      setStatus("The manifest CSV couldn't be built. Try again in a moment.");
      toast.error("Couldn't build the manifest CSV");
    } finally {
      setBusy(null);
      clearProgressSnapshot();
      setProgress({ done: 0, total: 0 });
    }
  }

  /** Renders the manifest rows on screen so they can be checked before exporting. */
  async function previewManifest() {
    if (!chosen.length) return;
    setBusy("csv");
    setProgress({ done: 0, total: chosen.length });
    setStatus("Building the manifest preview…");
    try {
      const rows = await buildManifestRows();
      if (rows.length < 2) throw new Error("no QR codes ready");
      setManifestPreview(rows);
      setStatus(`Manifest preview ready — ${rows.length - 1} row${rows.length === 2 ? "" : "s"}.`);
    } catch {
      setManifestPreview(null);
      setStatus("The manifest preview couldn't be built. Try again in a moment.");
      toast.error("Couldn't build the manifest preview");
    } finally {
      setBusy(null);
      clearProgressSnapshot();
      setProgress({ done: 0, total: 0 });
    }
  }


  /** Builds the ZIP. Nothing downloads here — it arms the Download ZIP button. */
  async function downloadPngs() {
    if (!chosen.length) return;
    cancelRef.current = false;
    discardReadyZip();
    setBusy("png");
    setProgress({ done: 0, total: chosen.length });
    startedAtRef.current = performance.now();
    setEta(null);
    setZipPct(null);
    setFailures([]);
    setChecks([]);
    setStatus("Packaging the QR images into a ZIP…");

    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      let added = 0;
      const generatedAt = new Date().toISOString();
      const rows: string[][] = [manifestHeader];
      const rowFor = (
        fileName: string,
        format: string,
        link: (typeof chosen)[number],
        size: string,
        bytes: Uint8Array,
        sha256: string,
        svgMeta?: { width: string; height: string; viewBox: string },
      ) => [
        fileName,
        format,
        link.packageName,
        link.label,
        (customLabels[link.id] ?? "").trim(),
        campaign.trim(),
        notes.trim(),
        link.url,
        link.id,
        size,
        svgMeta?.width ?? "",
        svgMeta?.height ?? "",
        svgMeta?.viewBox ?? "",
        pngBg,
        String(qrMargin),
        String(bytes.byteLength),
        sha256,
        generatedAt,
      ];


      const failed: { id: string; label: string; reason: string }[] = [];
      const upsertCheck = (key: string, patch: Partial<ChecksumCheck> & Pick<ChecksumCheck, "key">) =>
        setChecks((prev) => {
          const i = prev.findIndex((c) => c.key === key);
          if (i === -1) return [...prev, patch as ChecksumCheck];
          const next = [...prev];
          next[i] = { ...next[i]!, ...patch };
          return next;
        });

      /**
       * Hashes the bytes we generated, then re-reads the entry back out of the
       * ZIP and hashes that too. A mismatch means the archive is corrupt.
       */
      const hashAndVerify = async (
        fileName: string,
        format: "PNG" | "SVG",
        label: string,
        bytes: Uint8Array,
      ) => {
        const key = fileName;
        upsertCheck(key, { key, fileName, format, label, bytes: bytes.byteLength, sha256: "", state: "hashing" });
        await tick();
        const sha256 = await sha256Hex(bytes);
        upsertCheck(key, { key, sha256, state: "verifying" });
        await tick();
        const entry = zip.file(fileName);
        if (!entry) {
          upsertCheck(key, { key, state: "failed", detail: "Missing from the archive" });
          throw new Error(`${fileName} was not added to the ZIP`);
        }
        const stored = await entry.async("uint8array");
        const storedHash = await sha256Hex(stored);
        if (storedHash !== sha256 || stored.byteLength !== bytes.byteLength) {
          upsertCheck(key, { key, state: "failed", detail: "Checksum mismatch inside the ZIP" });
          throw new Error(`${fileName} failed its checksum check`);
        }
        upsertCheck(key, { key, state: "verified" });
        return sha256;
      };

      for (const link of chosen) {
        if (cancelRef.current) break;
        try {
          const canvas = canvasRefs.current[link.id];
          const flat = canvas ? flatten(canvas) : null;
          if (!flat) throw new Error("QR canvas wasn't rendered yet");
          const base64 = flat.toDataURL("image/png").split(",")[1];
          if (!base64) throw new Error("PNG encoding returned no data");
          const fileName = `png/hybrid-ai-records-qr-${link.id}-${pngSize}px.png`;
          zip.file(fileName, base64, { base64: true });
          const pngBytes = base64ToBytes(base64);
          rows.push(
            rowFor(
              fileName,
              "PNG",
              link,
              String(pngSize),
              pngBytes,
              await hashAndVerify(fileName, "PNG", link.label, pngBytes),
            ),
          );

          if (includeSvg) {
            const svg = serializeSvgWithMeta(svgRefs.current[link.id]);
            if (!svg) throw new Error("SVG vector wasn't rendered yet");
            const svgName = `svg/hybrid-ai-records-qr-${link.id}-${pngSize}px.svg`;
            zip.file(svgName, svg.text);
            const svgBytes = new TextEncoder().encode(svg.text);
            rows.push(
              rowFor(
                svgName,
                "SVG",
                link,
                String(pngSize),
                svgBytes,
                await hashAndVerify(svgName, "SVG", link.label, svgBytes),
                svg,
              ),
            );
          }




          added += 1;
        } catch (error) {
          // Keep going: one bad QR shouldn't block the rest of the pack.
          failed.push({
            id: link.id,
            label: link.label,
            reason: error instanceof Error ? error.message : "Unknown generation error",
          });
          setFailures([...failed]);
        }

        setProgress({ done: added + failed.length, total: chosen.length });
        trackEta(added + failed.length, chosen.length);
        await tick();
      }


      const discard = () => {
        // Drop every entry queued so far so no partial archive lingers in memory.
        for (const name of Object.keys(zip.files)) zip.remove(name);
        rows.length = 0;
        setStatus("Bulk ZIP export cancelled. Nothing was downloaded.");
        toast("Bulk QR export cancelled");
      };

      if (cancelRef.current) {
        discard();
        return;
      }

      if (!added) throw new Error("no QR codes ready");

      // Manifest so each image can be matched back to its label and share link.
      zip.file("qr-manifest.csv", `\uFEFF${toCsv(rows)}\r\n`);
      zip.file("qr-manifest.json", toManifestJson(rows));


      setStatus("Compressing the ZIP…");
      setEta("Compressing — almost done");
      const blob = await zip.generateAsync({ type: "blob" }, (meta) => {
        if (cancelRef.current) throw new Error("cancelled");
        setZipPct(Math.round(meta.percent));
      });
      setZipPct(null);

      // A cancel can land while the final blob is being assembled — drop it.
      if (cancelRef.current) {
        discard();
        return;
      }

      // The archive is complete — hold it and let the user click Download ZIP.
      const fileName = `hybrid-ai-records-qr-pack-${added}-links.zip`;
      setZipReady({
        url: URL.createObjectURL(blob),
        fileName,
        count: added,
        bytes: blob.size,
      });

      const skipped = failed.length
        ? ` ${failed.length} QR${failed.length === 1 ? "" : "s"} failed and ${failed.length === 1 ? "was" : "were"} skipped.`
        : "";
      setStatus(
        `ZIP ready with ${added} QR image${added === 1 ? "" : "s"} — use the Download ZIP button.${skipped}`,
      );
      if (failed.length) toast.warning(`ZIP ready — ${added} exported, ${failed.length} failed`);
      else toast.success(`ZIP ready — ${added} QR image${added === 1 ? "" : "s"}`);

    } catch {
      if (cancelRef.current) {
        setStatus("Bulk ZIP export cancelled. Nothing was downloaded.");
        toast("Bulk QR export cancelled");
        return;
      }

      setStatus("The QR ZIP couldn't be built. Try again in a moment.");
      toast.error("Couldn't build the QR ZIP");
    } finally {
      setBusy(null);
      clearProgressSnapshot();
      setProgress({ done: 0, total: 0 });
      setEta(null);
      setZipPct(null);
      cancelRef.current = false;

    }
  }


  return (
    <div className="mt-3 border border-white/15 bg-white/5 p-3 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="bulk-qr-panel"
        data-testid="bulk-qr-toggle"
        className="min-h-11 w-full text-left font-mono text-[11px] uppercase tracking-[0.18em] text-white/80 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
      >
        {open ? "− " : "+ "}Bulk QR codes for every share link
      </button>

      {open ? (
        <div id="bulk-qr-panel" className="mt-3 grid gap-3">
          <fieldset className="grid gap-2">
            <legend className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Links to include
            </legend>
            {links.map((link) => (
              <div key={link.id} className="grid gap-1">
                <label className="flex items-start gap-2 text-xs text-white/80">
                  <input
                    type="checkbox"
                    checked={selected.includes(link.id)}
                    onChange={() => toggle(link.id)}
                    data-testid={`bulk-qr-target-${link.id}`}
                    className="mt-0.5 h-4 w-4 accent-[#c81e33]"
                  />
                  <span>
                    <span className="block font-semibold text-white">{link.label}</span>
                    <span className="block break-all text-[10px] text-muted-foreground">
                      {link.url}
                    </span>
                  </span>
                </label>
                <input
                  type="text"
                  value={customLabels[link.id] ?? ""}
                  onChange={(e) =>
                    setCustomLabels((prev) => ({ ...prev, [link.id]: e.target.value }))
                  }
                  placeholder="Custom label for the manifest (optional)"
                  aria-label={`Custom manifest label for ${link.label}`}
                  data-testid={`bulk-qr-custom-label-${link.id}`}
                  className="ml-6 min-h-9 border border-white/15 bg-ink/30 px-2 py-1 text-[11px] text-white placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
                />
              </div>
            ))}
          </fieldset>

          <fieldset
            data-testid="bulk-qr-manifest-fields"
            className="grid gap-2 border border-white/15 bg-ink/20 p-3 sm:grid-cols-2"
          >
            <legend className="px-1 text-[10px] font-semibold uppercase tracking-widest text-white">
              Manifest details
            </legend>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Campaign
              <input
                type="text"
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
                placeholder="e.g. Summer flyer run"
                data-testid="bulk-qr-campaign"
                className="min-h-9 border border-white/15 bg-ink/30 px-2 py-1 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Notes
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything to record with this batch"
                data-testid="bulk-qr-notes"
                className="min-h-9 border border-white/15 bg-ink/30 px-2 py-1 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
              />
            </label>
            <p className="text-[10px] text-muted-foreground sm:col-span-2">
              These fields, plus package name and a generated-at timestamp, are written into
              qr-manifest.csv inside the ZIP.
            </p>
          </fieldset>


          <fieldset
            data-testid="bulk-qr-layout"
            className="grid gap-3 border border-white/15 bg-ink/20 p-3 sm:grid-cols-2"
          >
            <legend className="px-1 text-[10px] font-semibold uppercase tracking-widest text-white">
              PDF layout
            </legend>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground">
              Page size
              <select
                value={pdfSize}
                onChange={(e) => setPdfSize(e.target.value as PdfSize)}
                disabled={busy !== null}
                data-testid="bulk-qr-size"
                className="mt-1 min-h-10 w-full border border-white/20 bg-ink/40 px-2 text-xs text-white"
              >
                {PDF_SIZES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground">
              Orientation
              <select
                value={pdfOrientation}
                onChange={(e) => setPdfOrientation(e.target.value as PdfOrientation)}
                disabled={busy !== null}
                data-testid="bulk-qr-orientation"
                className="mt-1 min-h-10 w-full border border-white/20 bg-ink/40 px-2 text-xs text-white"
              >
                {PDF_ORIENTATIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground">
              Margins
              <select
                value={pdfMargin}
                onChange={(e) => setPdfMargin(e.target.value as PdfMargin)}
                disabled={busy !== null}
                data-testid="bulk-qr-margin"
                className="mt-1 min-h-10 w-full border border-white/20 bg-ink/40 px-2 text-xs text-white"
              >
                {PDF_MARGINS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.mm}mm)
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground">
              Label placement
              <select
                value={brandPlacement}
                onChange={(e) => setBrandPlacement(e.target.value as BrandPlacement)}
                disabled={busy !== null}
                data-testid="bulk-qr-brand"
                className="mt-1 min-h-10 w-full border border-white/20 bg-ink/40 px-2 text-xs text-white"
              >
                {BRAND_PLACEMENTS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset
            data-testid="bulk-qr-png-options"
            className="grid gap-3 border border-white/15 bg-ink/20 p-3 sm:grid-cols-3"
          >
            <legend className="px-1 text-[10px] font-semibold uppercase tracking-widest text-white">
              PNG image
            </legend>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground">
              Pixel size
              <select
                value={pngSize}
                onChange={(e) => setPngSize(Number(e.target.value))}
                disabled={busy !== null}
                data-testid="bulk-qr-png-size"
                className="mt-1 min-h-10 w-full border border-white/20 bg-ink/40 px-2 text-xs text-white"
              >
                {PNG_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}px
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground">
              Quiet margin
              <select
                value={qrMargin}
                onChange={(e) => setQrMargin(Number(e.target.value))}
                disabled={busy !== null}
                data-testid="bulk-qr-png-margin"
                className="mt-1 min-h-10 w-full border border-white/20 bg-ink/40 px-2 text-xs text-white"
              >
                {QR_MARGINS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground">
              Background
              <select
                value={pngBg}
                onChange={(e) => setPngBg(e.target.value)}
                disabled={busy !== null}
                data-testid="bulk-qr-png-bg"
                className="mt-1 min-h-10 w-full border border-white/20 bg-ink/40 px-2 text-xs text-white"
              >
                {PNG_BACKGROUNDS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground sm:col-span-3">
              <input
                type="checkbox"
                checked={includeSvg}
                onChange={(e) => setIncludeSvg(e.target.checked)}
                disabled={busy !== null}
                data-testid="bulk-qr-include-svg"
                className="h-4 w-4 accent-[oklch(0.55_0.22_25)]"
              />
              Also include crisp vector SVG files in the ZIP
            </label>
            <p className="text-[11px] normal-case tracking-normal text-muted-foreground sm:col-span-3">
              These settings apply to the ZIP images and previews. PDF pages always print on white.
            </p>

          </fieldset>


          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={downloadPdf}
              disabled={!chosen.length || busy !== null}
              data-testid="bulk-qr-pdf"
              className="btn-primary min-h-11 flex-1 text-xs disabled:opacity-60"
            >
              {busy === "pdf"
                ? "Building PDF…"
                : `Download ${chosen.length} QR${chosen.length === 1 ? "" : "s"} as PDF`}
            </button>
            <button
              type="button"
              onClick={downloadPngs}
              disabled={!chosen.length || busy !== null}
              data-testid="bulk-qr-png"
              className="min-h-11 flex-1 border border-white px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-black disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              {busy === "png" ? "Zipping PNGs…" : "Prepare PNG ZIP"}
            </button>
          </div>

          {/* Only clickable once the archive is fully built and verified. */}
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={zipReady?.url ?? undefined}
              download={zipReady?.fileName}
              aria-disabled={!zipReady}
              data-testid="bulk-qr-zip-download"
              onClick={(e) => {
                if (!zipReady) e.preventDefault();
              }}
              className={
                zipReady
                  ? "inline-flex min-h-11 flex-1 items-center justify-center gap-2 border-2 border-[#4b8bff] bg-[#4b8bff]/15 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-[#4b8bff]/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
                  : "pointer-events-none inline-flex min-h-11 flex-1 cursor-not-allowed items-center justify-center gap-2 border-2 border-white/20 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white/40"
              }
            >
              {zipReady
                ? `Download ZIP — ${zipReady.count} QR${zipReady.count === 1 ? "" : "s"} · ${(zipReady.bytes / 1024 / 1024).toFixed(2)} MB`
                : busy === "png"
                  ? "Download ZIP — preparing…"
                  : "Download ZIP — not ready yet"}
            </a>
          </div>
          <p className="text-[11px] leading-relaxed text-white/55">
            {zipReady
              ? "Your ZIP is finished and ready to save."
              : "Prepare the ZIP first — the download button unlocks the moment it finishes."}
          </p>


          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={previewPdf}
              disabled={!chosen.length || busy !== null}
              data-testid="bulk-qr-preview-pdf"
              className="min-h-11 flex-1 border border-white/40 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:border-white disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              {busy === "preview" ? "Rendering preview…" : "Preview PDF"}
            </button>
            <button
              type="button"
              onClick={refreshThumbs}
              disabled={!chosen.length || busy !== null}
              data-testid="bulk-qr-preview-pngs"
              className="min-h-11 flex-1 border border-white/40 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:border-white disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              Preview PNG grid
            </button>
            <button
              type="button"
              onClick={refreshSvgPreviews}
              disabled={!chosen.length || !includeSvg || busy !== null}
              data-testid="bulk-qr-preview-svgs"
              title={includeSvg ? undefined : "Turn on SVG export to preview vectors"}
              className="min-h-11 flex-1 border border-white/40 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:border-white disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              Preview SVG grid
            </button>
          </div>

          {busy ? (
            <button
              type="button"
              onClick={cancelExport}
              disabled={cancelRef.current}
              data-testid="bulk-qr-cancel-top"
              className="min-h-11 w-full border border-[oklch(0.55_0.22_25)] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-[oklch(0.72_0.19_25)] transition-colors hover:bg-[oklch(0.55_0.22_25)] hover:text-white disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              Cancel export &amp; discard partial files
            </button>
          ) : null}

          {!busy && recovered ? (
            <div
              data-testid="bulk-qr-recovered"
              className="border border-[#4b8bff]/60 bg-[#4b8bff]/10 p-3 text-xs text-white"
            >
              <p className="font-semibold uppercase tracking-widest text-[#9dc0ff]">
                Recovered interrupted export
              </p>
              <p className="mt-1 text-white/80">
                The last {recovered.kind.toUpperCase()} export stopped at {recovered.progress.done}/
                {recovered.progress.total}
                {recovered.eta ? ` (${recovered.eta})` : ""}. Files aren&apos;t kept across a refresh — run the
                export again to finish it.
              </p>
              <button
                type="button"
                onClick={clearProgressSnapshot}
                className="mt-2 min-h-9 border border-white/40 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-widest text-white transition-colors hover:border-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {failures.length ? (

            <div
              data-testid="bulk-qr-failures"
              className="border border-[oklch(0.55_0.22_25)] bg-[oklch(0.55_0.22_25)]/10 p-3 text-xs text-white"
            >
              <p className="font-semibold uppercase tracking-widest text-[oklch(0.78_0.19_25)]">
                {failures.length} QR{failures.length === 1 ? "" : "s"} failed — the rest were exported
              </p>
              <ul className="mt-2 space-y-1">
                {failures.map((f) => (
                  <li key={f.id} className="flex flex-wrap gap-x-2 text-white/80">
                    <span className="font-semibold text-white">{f.label}</span>
                    <span className="text-white/50">({f.id})</span>
                    <span>— {f.reason}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setFailures([])}
                className="mt-2 min-h-9 border border-white/40 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-widest text-white transition-colors hover:border-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
              >
                Dismiss errors
              </button>
            </div>
          ) : null}




          {checks.length ? (
            <div
              data-testid="bulk-qr-checksums"
              className="border border-white/20 bg-white/5 p-3 text-xs text-white"
            >
              <p className="font-semibold uppercase tracking-widest text-[#9dc0ff]">
                Live checksum verification —{" "}
                {checks.filter((c) => c.state === "verified").length}/{checks.length} verified
                {checks.some((c) => c.state === "failed")
                  ? `, ${checks.filter((c) => c.state === "failed").length} failed`
                  : ""}
              </p>
              <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1 font-mono text-[0.68rem]">
                {checks.map((c) => (
                  <li key={c.key} className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      aria-hidden="true"
                      className={
                        c.state === "verified"
                          ? "text-[oklch(0.8_0.17_150)]"
                          : c.state === "failed"
                            ? "text-[oklch(0.78_0.19_25)]"
                            : "text-white/50"
                      }
                    >
                      {c.state === "verified" ? "✓" : c.state === "failed" ? "✕" : "…"}
                    </span>
                    <span className="text-white/80">{c.fileName}</span>
                    <span className="text-white/40">{c.bytes.toLocaleString()} B</span>
                    <span className="text-white/60">
                      {c.state === "hashing"
                        ? "hashing…"
                        : c.state === "verifying"
                          ? "verifying…"
                          : c.detail
                            ? c.detail
                            : `sha256 ${c.sha256.slice(0, 16)}…`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 font-sans text-[0.65rem] text-white/50">
                Each file is hashed, then re-read from the archive and hashed again before the ZIP is offered
                for download.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">

            <button
              type="button"
              onClick={downloadManifestCsv}
              disabled={!chosen.length || busy !== null}
              data-testid="bulk-qr-manifest-csv"
              className="min-h-11 flex-1 border border-white/40 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:border-white disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              {busy === "csv" ? "Building CSV…" : "Download manifest CSV only"}
            </button>
            <button
              type="button"
              onClick={downloadManifestJson}
              disabled={!chosen.length || busy !== null}
              data-testid="bulk-qr-manifest-json"
              className="min-h-11 flex-1 border border-white/40 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:border-white disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              {busy === "json" ? "Building JSON…" : "Download manifest JSON only"}
            </button>

            <button
              type="button"
              onClick={previewManifest}
              disabled={!chosen.length || busy !== null}
              data-testid="bulk-qr-preview-manifest"
              className="min-h-11 flex-1 border border-white/40 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:border-white disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              Preview manifest rows
            </button>
          </div>

          {manifestPreview ? (
            <div data-testid="bulk-qr-manifest-preview" className="space-y-2 border border-white/15 p-2">
              <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-widest text-white">
                <span>
                  qr-manifest.csv — {manifestPreview.length - 1} row
                  {manifestPreview.length === 2 ? "" : "s"}
                </span>
                <button
                  type="button"
                  onClick={() => setManifestPreview(null)}
                  data-testid="bulk-qr-manifest-preview-close"
                  className="min-h-9 border border-white/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
                >
                  Hide
                </button>
              </div>
              <div className="max-h-72 overflow-auto">
                <table className="w-full min-w-[900px] border-collapse text-left text-[11px] text-white/80">
                  <thead className="sticky top-0 bg-ink/80 backdrop-blur-sm">
                    <tr>
                      {(manifestPreview[0] ?? []).map((head) => (
                        <th
                          key={head}
                          scope="col"
                          className="whitespace-nowrap border-b border-white/20 px-2 py-1 font-semibold uppercase tracking-widest text-white"
                        >
                          {head.replace(/_/g, " ")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {manifestPreview.slice(1).map((row, i) => (
                      <tr key={`${row[0]}-${i}`} className="odd:bg-white/5">
                        {row.map((cell, j) => (
                          <td
                            key={j}
                            title={cell}
                            className="max-w-[220px] truncate border-b border-white/10 px-2 py-1 font-mono"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-white/60">
                These are the exact rows that ship as qr-manifest.csv (and qr-manifest.json) inside the ZIP.
              </p>
            </div>
          ) : null}

          <QrManifestVerifier />





          {preview ? (
            <div data-testid="bulk-qr-pdf-preview" className="space-y-2 border border-white/15 p-2">
              <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-widest text-white">
                <span>
                  Page {previewPage} of {preview.pages}
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}
                    disabled={previewPage <= 1}
                    data-testid="bulk-qr-preview-prev"
                    className="min-h-9 border border-white/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white disabled:opacity-40 hover:bg-white hover:text-black"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewPage((p) => Math.min(preview.pages, p + 1))}
                    disabled={previewPage >= preview.pages}
                    data-testid="bulk-qr-preview-next"
                    className="min-h-9 border border-white/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white disabled:opacity-40 hover:bg-white hover:text-black"
                  >
                    Next
                  </button>
                  <button
                    type="button"
                    onClick={closePreview}
                    data-testid="bulk-qr-preview-close"
                    className="min-h-9 border border-white/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white hover:bg-white hover:text-black"
                  >
                    Close
                  </button>
                </span>
              </div>
              <iframe
                key={`${preview.url}#${previewPage}`}
                src={`${preview.url}#page=${previewPage}&toolbar=0&view=FitH`}
                title={`Bulk QR PDF preview, page ${previewPage}`}
                className="h-[460px] w-full border border-white/10 bg-white"
              />
              <p className="text-[10px] text-muted-foreground">
                Preview only — nothing is saved until you download.
              </p>
            </div>
          ) : null}

          {thumbs.length ? (
            <div data-testid="bulk-qr-png-grid" className="space-y-2 border border-white/15 p-2">
              <div className="flex items-center justify-between text-[11px] uppercase tracking-widest text-white">
                <span>{thumbs.length} PNG thumbnails</span>
                <button
                  type="button"
                  onClick={() => setThumbs([])}
                  className="min-h-9 border border-white/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white hover:bg-white hover:text-black"
                >
                  Close
                </button>
              </div>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {thumbs.map((thumb) => (
                  <li key={thumb.id} className="border border-white/10 bg-white/5 p-2 text-center">
                    <img
                      src={thumb.src}
                      alt={`QR code for ${thumb.label}`}
                      className="mx-auto aspect-square w-full max-w-[140px] bg-white object-contain"
                      loading="lazy"
                    />
                    <span className="mt-1 block text-[10px] text-muted-foreground">
                      {thumb.label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {svgPreviews.length ? (
            <div data-testid="bulk-qr-svg-grid" className="space-y-2 border border-white/15 p-2">
              <div className="flex items-center justify-between text-[11px] uppercase tracking-widest text-white">
                <span>{svgPreviews.length} SVG vectors</span>
                <button
                  type="button"
                  onClick={() => setSvgPreviews([])}
                  data-testid="bulk-qr-svg-grid-close"
                  className="min-h-9 border border-white/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white hover:bg-white hover:text-black"
                >
                  Close
                </button>
              </div>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {svgPreviews.map((item) => (
                  <li key={item.id} className="border border-white/10 bg-white/5 p-2 text-center">
                    <img
                      src={item.src}
                      alt={`Vector QR code for ${item.label}`}
                      className="mx-auto aspect-square w-full max-w-[140px] object-contain"
                      style={{ backgroundColor: pngBg === "transparent" ? undefined : pngBg }}
                      loading="lazy"
                    />
                    <span className="mt-1 block text-[10px] text-muted-foreground">{item.label}</span>
                    <span className="mt-0.5 block font-mono text-[9px] text-muted-foreground">
                      {item.width}×{item.height} · viewBox {item.viewBox || "—"} · {(item.bytes / 1024).toFixed(1)} KB
                    </span>
                    <a
                      href={item.src}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-[10px] uppercase tracking-widest text-[#4b8bff] underline"
                    >
                      Open full size
                    </a>
                  </li>
                ))}
              </ul>
              <p className="text-[10px] text-muted-foreground">
                Preview only — these are the exact vectors bundled in the ZIP's svg/ folder.
              </p>
            </div>
          ) : null}




          {busy ? (
            <div data-testid="bulk-qr-progress" className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-widest text-white">
                <span>
                  {zipPct !== null
                    ? `Compressing ZIP — ${zipPct}%`
                    : `${busy === "pdf" ? "Building PDF" : busy === "csv" ? "Building CSV" : busy === "json" ? "Building JSON" : "Zipping PNGs"} — ${progress.done}/${progress.total}`}
                </span>

                <button
                  type="button"
                  onClick={cancelExport}
                  data-testid="bulk-qr-cancel"
                  className="min-h-9 border border-[oklch(0.55_0.22_25)] px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-[oklch(0.72_0.19_25)] transition-colors hover:bg-[oklch(0.55_0.22_25)] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
                >
                  Cancel
                </button>
              </div>
              <div
                role="progressbar"
                aria-label="Bulk QR generation progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(
                  zipPct !== null
                    ? zipPct
                    : progress.total
                      ? (progress.done / progress.total) * 100
                      : 0,
                )}
                className="h-2 w-full overflow-hidden border border-white/20 bg-white/10"
              >
                <div
                  className="h-full bg-[oklch(0.55_0.22_25)] transition-[width] duration-200"
                  style={{
                    width: `${
                      zipPct !== null
                        ? zipPct
                        : progress.total
                          ? (progress.done / progress.total) * 100
                          : 0
                    }%`,
                  }}
                />
              </div>
              <p data-testid="bulk-qr-eta" aria-live="polite" className="text-[11px] text-muted-foreground">
                {eta ?? "Estimating time remaining…"}
              </p>
            </div>

          ) : null}



          <p className="text-[11px] text-muted-foreground">
            One page per link, print-ready with the label header and footer. High error correction
            keeps every code scannable on flyers and posters.
          </p>

          <p role="status" aria-live="polite" className="sr-only">
            {status}
          </p>
        </div>
      ) : null}

      {/* Off-screen render targets: the canvases the exports read from. */}
      <div aria-hidden="true" className="pointer-events-none absolute -left-[9999px] top-0 h-0 w-0 overflow-hidden">
        {links.map((link) => (
          <QRCodeCanvas
            key={link.id}
            value={link.url}
            size={pngSize}
            level="H"
            marginSize={qrMargin}
            bgColor={pngBg === "transparent" ? "#00000000" : pngBg}
            fgColor={pngBg === "#111111" ? "#ffffff" : "#000000"}

            ref={(el: HTMLCanvasElement | null) => {
              canvasRefs.current[link.id] = el;
            }}
          />
        ))}
        {includeSvg
          ? links.map((link) => (
              <QRCodeSVG
                key={`svg-${link.id}`}
                value={link.url}
                size={pngSize}
                level="H"
                marginSize={qrMargin}
                bgColor={pngBg === "transparent" ? "transparent" : pngBg}
                fgColor={pngBg === "#111111" ? "#ffffff" : "#000000"}
                ref={(el: SVGSVGElement | null) => {
                  svgRefs.current[link.id] = el;
                }}
              />
            ))
          : null}
      </div>

    </div>
  );
}
