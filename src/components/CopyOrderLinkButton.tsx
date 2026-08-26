import { Component, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Check, Download, FileText, ExternalLink, ImageDown, Link2, Printer, QrCode, RefreshCw, Share2 } from "lucide-react";

import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { orderUrl, type OrderPackage, type OrderPrefill } from "@/lib/order-link";
import logoAsset from "@/assets/hybrid-ai-records-logo.png.asset.json";

/** Branding drawn on the header/footer bands of the QR PDF. */
const PDF_BRAND = {
  label: "HYBRID AI RECORDS LLC",
  tagline: "Independent label · Nashville, TN",
  footer: "Hybrid.AI.Records@proton.me · hybrid-ai-records.com",
  accent: "#e11d2e",
  ink: "#16181c",
} as const;

const btnCls =
  "inline-flex w-full items-center justify-center gap-2 border border-border bg-transparent px-4 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:border-primary hover:text-status-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const selectCls =
  "w-full border border-border bg-background/60 px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** On-screen QR sizes. Bigger renders scan from further away / on older cameras. */
const QR_SIZES = {
  small: 144,
  medium: 200,
  large: 280,
} as const;
type QrSize = keyof typeof QR_SIZES;

/**
 * Error-correction levels. Higher levels survive glare, print smudges and
 * partially covered codes, at the cost of a denser (harder to scan small) grid.
 */
const QR_LEVELS = {
  L: "Low — 7% recovery (sparsest grid)",
  M: "Medium — 15% recovery (default)",
  Q: "Quartile — 25% recovery",
  H: "High — 30% recovery (most robust)",
} as const;
type QrLevel = keyof typeof QR_LEVELS;

/** Export resolutions for the downloaded PNG (square, in pixels). */
const QR_PNG_RESOLUTIONS = [1024, 2048, 4096] as const;
type QrPngRes = (typeof QR_PNG_RESOLUTIONS)[number];
const QR_PNG_RES_LABELS: Record<QrPngRes, string> = {
  1024: "1024px — web & email",
  2048: "2048px — large print",
  4096: "4096px — poster / banner",
};

/** Page sizes offered for the print-ready PDF export. */
const QR_PDF_SIZES = ["letter", "a4"] as const;
type QrPdfSize = (typeof QR_PDF_SIZES)[number];
const QR_PDF_SIZE_LABELS: Record<QrPdfSize, string> = {
  letter: "US Letter — 8.5 × 11 in",
  a4: "A4 — 210 × 297 mm",
};

/** Page orientations offered for the print-ready PDF export. */
const QR_PDF_ORIENTATIONS = ["portrait", "landscape"] as const;
type QrPdfOrientation = (typeof QR_PDF_ORIENTATIONS)[number];
const QR_PDF_ORIENTATION_LABELS: Record<QrPdfOrientation, string> = {
  portrait: "Portrait — tall page",
  landscape: "Landscape — wide page",
};

const QR_PREFS_KEY = "hybrid:qr-prefs";

function isSize(v: unknown): v is QrSize {
  return typeof v === "string" && v in QR_SIZES;
}
function isLevel(v: unknown): v is QrLevel {
  return typeof v === "string" && v in QR_LEVELS;
}
function isPngRes(v: unknown): v is QrPngRes {
  return typeof v === "number" && (QR_PNG_RESOLUTIONS as readonly number[]).includes(v);
}
function isPdfSize(v: unknown): v is QrPdfSize {
  return typeof v === "string" && (QR_PDF_SIZES as readonly string[]).includes(v);
}
function isPdfOrientation(v: unknown): v is QrPdfOrientation {
  return typeof v === "string" && (QR_PDF_ORIENTATIONS as readonly string[]).includes(v);
}


/** Max bytes a version-40 QR can hold per error-correction level (byte mode). */
const QR_BYTE_CAPACITY: Record<QrLevel, number> = { L: 2953, M: 2331, Q: 1663, H: 1273 };

/**
 * Validates the share URL before we hand it to the encoder, so the user sees a
 * plain-language reason instead of a blank or broken code.
 */
function validateShareUrl(url: string, level: QrLevel): string | null {
  if (typeof window === "undefined") return "This link can only be generated in your browser.";
  if (!url || url.trim().length === 0) return "The share link is empty right now.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The share link isn't a valid web address.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The share link isn't a valid web address.";
  }
  const bytes = new TextEncoder().encode(url).length;
  const cap = QR_BYTE_CAPACITY[level];
  if (bytes > cap) {
    return `This link is too long for a QR code at this error-correction level (${bytes} of ${cap} characters). Shorten your demo link or lower the error correction, then retry.`;
  }
  return null;
}

/** Catches an encoder crash so the whole order form never goes blank. */
class QrRenderBoundary extends Component<
  { resetKey: string; onError: (message: string) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError("The QR code couldn't be generated from this link.");
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}



/**
 * Copies the canonical shareable order-form URL — `/portal#order`, or
 * `/portal?package=<slug>#order` when a package is selected. On devices with the
 * Web Share API (phones/tablets) it also offers the native share sheet.
 */
export function CopyOrderLinkButton({
  pkg,
  details,
}: {
  pkg?: OrderPackage | null;
  /** Entered details carried in the link so it restores the form. */
  details?: OrderPrefill | null;
}) {
  const [copied, setCopied] = useState(false);
  /** True while a clipboard write is in flight, for the button's loading state. */
  const [copying, setCopying] = useState(false);
  /** Screen-reader announcement for the outcome of the last copy attempt. */
  const [copyAnnounce, setCopyAnnounce] = useState("");

  /** True while the share link is being opened in a new tab. */
  const [opening, setOpening] = useState(false);
  /** Briefly true after a successful open, for the visual confirmation. */
  const [opened, setOpened] = useState(false);
  /** Screen-reader announcement for the outcome of the last open attempt. */
  const [openAnnounce, setOpenAnnounce] = useState("");
  const openBtnRef = useRef<HTMLButtonElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** True while the hidden print frame is being prepared. */
  const [printing, setPrinting] = useState(false);
  /** Screen-reader announcement for the print flow. */
  const [printAnnounce, setPrintAnnounce] = useState("");
  const printBtnRef = useRef<HTMLButtonElement | null>(null);
  const printFrameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);



  /** Live share URL rendered as a QR code; null while the panel is closed. */
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  /** Set when every clipboard path is blocked — user copies manually. */
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const manualRef = useRef<HTMLInputElement | null>(null);
  /** QR panel + its toggle, for open/close focus management. */
  const qrPanelRef = useRef<HTMLDivElement | null>(null);
  const qrToggleRef = useRef<HTMLButtonElement | null>(null);
  const copyBtnRef = useRef<HTMLButtonElement | null>(null);
  /** True only when the panel was opened by the user, so we don't steal focus. */
  const qrJustOpened = useRef(false);
  /** Off-screen high-resolution canvas used to export the QR as a PNG. */
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const qrSvgWrapRef = useRef<HTMLDivElement | null>(null);

  const qrDownloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [qrDownloaded, setQrDownloaded] = useState<"png" | "svg" | "jpg" | "pdf" | null>(null);
  /** Scan tuning: render size + error-correction level, remembered per device. */
  const [qrSize, setQrSize] = useState<QrSize>("medium");
  const [qrLevel, setQrLevel] = useState<QrLevel>("M");
  /** Pixel size of the exported PNG, remembered per device. */
  const [qrPngRes, setQrPngRes] = useState<QrPngRes>(1024);
  /** Page size used by the print-ready PDF export, remembered per device. */
  const [qrPdfSize, setQrPdfSize] = useState<QrPdfSize>("letter");
  /** Page orientation used by the print-ready PDF export, remembered per device. */
  const [qrPdfOrientation, setQrPdfOrientation] = useState<QrPdfOrientation>("portrait");
  /** Adds the branded header/footer bands (logo + label text) to the PDF export. */
  const [qrPdfBrand, setQrPdfBrand] = useState(true);
  /** Cached data URL of the label logo so repeat PDF exports stay instant. */
  const brandLogoRef = useRef<string | null>(null);
  /** True while the print-ready PDF is being generated. */
  const [pdfBuilding, setPdfBuilding] = useState(false);
  /** Adds a label + share URL caption strip under the exported image. */
  const [qrCaption, setQrCaption] = useState(false);
  /** When true, the caption prints a shortened link instead of the full URL. */
  const [qrCaptionShort, setQrCaptionShort] = useState(false);
  /** Encoder crash message (validation problems are derived, not stored). */
  const [renderError, setRenderError] = useState<string | null>(null);
  /** Bumped by Retry to force a clean re-render of the encoder. */
  const [qrAttempt, setQrAttempt] = useState(0);
  /**
   * The payload signature that has finished encoding. Anything else means a new
   * payload is still being generated — derived synchronously so the live region
   * always announces "generating" before it announces success.
   */
  const [qrSettledKey, setQrSettledKey] = useState<string | null>(null);



  /** Resolved after mount so SSR markup stays identical for every device. */
  const [canShare, setCanShare] = useState(false);
  /** "Ctrl" until we can detect an Apple platform after mount, then "⌘". */
  const [modKeyLabel, setModKeyLabel] = useState("Ctrl");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    if (typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)) {
      setModKeyLabel("⌘");
    }
    // Restore saved scan settings after mount so SSR/hydration markup matches.
    try {
      const raw = window.localStorage.getItem(QR_PREFS_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as {
          size?: unknown;
          level?: unknown;
          pngRes?: unknown;
          caption?: unknown;
          captionShort?: unknown;
          pdfSize?: unknown;
          pdfOrientation?: unknown;
          pdfBrand?: unknown;
        };
        if (isSize(saved.size)) setQrSize(saved.size);
        if (isLevel(saved.level)) setQrLevel(saved.level);
        if (isPngRes(saved.pngRes)) setQrPngRes(saved.pngRes);
        if (typeof saved.caption === "boolean") setQrCaption(saved.caption);
        if (typeof saved.captionShort === "boolean") setQrCaptionShort(saved.captionShort);
        if (isPdfSize(saved.pdfSize)) setQrPdfSize(saved.pdfSize);
        if (isPdfOrientation(saved.pdfOrientation)) setQrPdfOrientation(saved.pdfOrientation);
        if (typeof saved.pdfBrand === "boolean") setQrPdfBrand(saved.pdfBrand);
      }
    } catch {
      /* storage blocked — defaults are fine */
    }

    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (qrDownloadTimer.current) clearTimeout(qrDownloadTimer.current);
      if (openTimer.current) clearTimeout(openTimer.current);
      if (printFrameTimer.current) clearTimeout(printFrameTimer.current);
    };
  }, []);

  // Auto-select the manual field so the user only needs Ctrl/Cmd+C.
  useEffect(() => {
    if (!manualUrl) return;
    const el = manualRef.current;
    if (!el) return;
    el.focus();
    el.select();
    el.setSelectionRange(0, el.value.length);
  }, [manualUrl]);

  const shareUrl = () => {
    try {
      const origin = typeof window === "undefined" ? "" : window.location.origin;
      return `${origin}${orderUrl(pkg ?? null, details ?? null)}`;
    } catch {
      return "";
    }
  };

  // Keep the visible QR in sync while the user keeps editing tier/details.
  useEffect(() => {
    setQrUrl((current) => (current === null ? null : shareUrl()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg, details?.artist, details?.email, details?.link]);

  /** Validation runs on every change so the error clears itself once fixed. */
  const urlError = qrUrl === null ? null : validateShareUrl(qrUrl, qrLevel);
  const qrError = urlError ?? renderError;
  const qrReady = qrUrl !== null && !qrError;

  // A fresh link or level clears a previous encoder crash automatically.
  useEffect(() => {
    setRenderError(null);
  }, [qrUrl, qrLevel, qrAttempt]);

  /** Identifies the payload currently on screen. */
  const qrKey = qrUrl === null ? null : `${qrAttempt}|${qrLevel}|${qrSize}|${qrUrl}`;
  // Derived (not effect-set) so the first render of a new payload already reads
  // as "generating"; the effect only marks it settled a beat later.
  const qrGenerating = qrKey !== null && qrKey !== qrSettledKey;

  useEffect(() => {
    if (qrKey === null) {
      setQrSettledKey(null);
      return;
    }
    const id = setTimeout(() => setQrSettledKey(qrKey), 300);
    return () => clearTimeout(id);
  }, [qrKey]);

  /** Live status text for assistive tech: generating → rendered → failed. */
  // Retry attempts are numbered so a repeated identical failure still re-announces.
  const qrRetryPrefix = qrAttempt > 0 ? `Retry ${qrAttempt}: ` : "";
  const qrStatusMessage =
    qrUrl === null
      ? ""
      : qrError
        ? `${qrRetryPrefix}QR code could not be generated. ${qrError}`
        : qrGenerating
          ? `${qrRetryPrefix}Generating QR code…`
          : `${qrRetryPrefix}QR code generated successfully for ${qrUrl}`;



  // Move focus into the panel on open so keyboard/screen-reader users land on it.
  useEffect(() => {
    if (qrUrl === null || !qrJustOpened.current) return;
    qrJustOpened.current = false;
    qrPanelRef.current?.focus();
  }, [qrUrl]);

  /** Rebuilds the link and re-renders the encoder from scratch. */
  function retryQr() {
    setRenderError(null);
    setQrAttempt((n) => n + 1);
    const next = shareUrl();
    setQrUrl(next);
    const problem = validateShareUrl(next, qrLevel);
    if (problem) {
      toast.error("QR code still can't be generated", { description: problem });
    } else {
      toast.success("QR code regenerated");
      // The Retry button unmounts once the code renders — keep focus in the panel.
      requestAnimationFrame(() => qrPanelRef.current?.focus());
    }

  }

  /** Opens/closes the panel and returns focus to the toggle on close. */
  function toggleQr() {
    if (qrUrl !== null) {
      closeQr();
      return;
    }
    qrJustOpened.current = true;
    setRenderError(null);
    setQrUrl(shareUrl());
  }

  function closeQr() {
    qrJustOpened.current = false;
    setQrUrl(null);
    setRenderError(null);
    // Always land back on the toggle, whichever way the panel was dismissed.
    requestAnimationFrame(() => qrToggleRef.current?.focus());
  }

  /** Tab/Shift+Tab cycle inside the open panel instead of escaping it. */
  function trapTab(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const panel = qrPanelRef.current;
    if (!panel) return;
    const items = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Clicking outside the open panel closes it and restores focus to the toggle.
  useEffect(() => {
    if (qrUrl === null) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (qrPanelRef.current?.contains(target)) return;
      if (qrToggleRef.current?.contains(target)) return;
      closeQr();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrUrl]);



  /** Saves the off-screen high-resolution canvas as a PNG file. */
  /** Persists the scan settings so the next visit renders the same QR. */
  function savePrefs(next: {
    size?: QrSize;
    level?: QrLevel;
    pngRes?: QrPngRes;
    caption?: boolean;
    captionShort?: boolean;
    pdfSize?: QrPdfSize;
    pdfOrientation?: QrPdfOrientation;
    pdfBrand?: boolean;
  }) {
    try {
      window.localStorage.setItem(
        QR_PREFS_KEY,
        JSON.stringify({
          size: next.size ?? qrSize,
          level: next.level ?? qrLevel,
          pngRes: next.pngRes ?? qrPngRes,
          caption: next.caption ?? qrCaption,
          captionShort: next.captionShort ?? qrCaptionShort,
          pdfSize: next.pdfSize ?? qrPdfSize,
          pdfOrientation: next.pdfOrientation ?? qrPdfOrientation,
          pdfBrand: next.pdfBrand ?? qrPdfBrand,
        }),
      );
    } catch {
      /* storage blocked — the choice still applies for this session */
    }
  }

  function changeSize(value: QrSize) {
    setQrSize(value);
    savePrefs({ size: value });
  }

  function changeLevel(value: QrLevel) {
    setQrLevel(value);
    savePrefs({ level: value });
  }

  function changePngRes(value: QrPngRes) {
    if (!isPngRes(value)) return;
    setQrPngRes(value);
    savePrefs({ pngRes: value });
  }

  function changeCaption(value: boolean) {
    setQrCaption(value);
    savePrefs({ caption: value });
  }

  function changeCaptionShort(value: boolean) {
    setQrCaptionShort(value);
    savePrefs({ captionShort: value });
  }

  function changePdfSize(value: string) {
    if (!isPdfSize(value)) return;
    setQrPdfSize(value);
    savePrefs({ pdfSize: value });
  }

  function changePdfOrientation(value: string) {
    if (!isPdfOrientation(value)) return;
    setQrPdfOrientation(value);
    savePrefs({ pdfOrientation: value });
  }

  function changePdfBrand(value: boolean) {
    setQrPdfBrand(value);
    savePrefs({ pdfBrand: value });
  }

  /**
   * Loads the label logo once and caches it as a data URL. Returns null when the
   * asset can't be fetched so the PDF still exports (text-only branding).
   */
  async function brandLogoDataUrl(): Promise<string | null> {
    if (brandLogoRef.current) return brandLogoRef.current;
    try {
      const res = await fetch(logoAsset.url);
      if (!res.ok) return null;
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("logo read failed"));
        reader.readAsDataURL(blob);
      });
      brandLogoRef.current = dataUrl;
      return dataUrl;
    } catch {
      return null;
    }
  }




  /**
   * Compact, post-friendly rendering of the share URL: drops the protocol and
   * "www.", and keeps only the package hint instead of the full query string.
   * The QR itself always encodes the full URL.
   */
  function shortCaptionUrl(url: string) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      const slug = u.searchParams.get("package");
      const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
      return `${host}${path}${slug ? `/${slug}` : ""}${u.hash || "#order"}`;
    } catch {
      return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
    }
  }

  /** Text used in the exported caption strip. */
  function captionUrlText() {
    const url = qrUrl ?? "";
    return qrCaptionShort ? shortCaptionUrl(url) : url;
  }




  /** Package-scoped download filename, e.g. hybrid-ai-records-order-...-qr-2048.png */
  function qrFileName(ext: "png" | "svg" | "jpg" | "pdf") {
    const slug = pkg
      ? `-${pkg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`
      : "";
    const res =
      ext === "svg"
        ? ""
        : ext === "pdf"
          ? `-${qrPdfSize}-${qrPdfOrientation}${qrPdfBrand ? "-branded" : ""}`
          : `-${qrPngRes}`;
    return `hybrid-ai-records-order${slug}-qr${res}.${ext}`;
  }


  /** Triggers a browser download for an object/data URL. */
  function triggerDownload(href: string, fileName: string) {
    const link = document.createElement("a");
    link.href = href;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function flagDownloaded(kind: "png" | "svg" | "jpg" | "pdf", fileName: string) {
    setQrDownloaded(kind);
    toast.success(`QR code downloaded as ${kind.toUpperCase()}`, { description: fileName });
    if (qrDownloadTimer.current) clearTimeout(qrDownloadTimer.current);
    qrDownloadTimer.current = setTimeout(() => setQrDownloaded(null), 2500);
  }

  /**
   * Draws the QR onto a taller canvas with a caption block underneath (label +
   * wrapped share URL) so the exported image reads as a finished post asset.
   */
  function captionedCanvas(source: HTMLCanvasElement) {
    const w = source.width;
    const pad = Math.round(w * 0.06);
    const titleSize = Math.round(w * 0.045);
    const urlSize = Math.round(w * 0.028);
    const lineGap = Math.round(urlSize * 1.45);

    const measure = document.createElement("canvas").getContext("2d");
    if (!measure) return null;
    measure.font = `${urlSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const maxLine = w - pad * 2;
    const lines: string[] = [];
    let current = "";
    for (const ch of captionUrlText()) {
      const next = current + ch;
      if (measure.measureText(next).width > maxLine && current) {
        lines.push(current);
        current = ch;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);

    const title = `HYBRID AI RECORDS${pkg ? ` — ${pkg}` : ""}`;
    const captionH = pad + titleSize + Math.round(pad * 0.6) + lines.length * lineGap + pad;

    const out = document.createElement("canvas");
    out.width = w;
    out.height = source.height + captionH;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0);

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#0a0a0a";
    ctx.font = `600 ${titleSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    let y = source.height + pad;
    ctx.fillText(title, w / 2, y);
    y += titleSize + Math.round(pad * 0.6);
    ctx.fillStyle = "#3f3f46";
    ctx.font = `${urlSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    for (const line of lines) {
      ctx.fillText(line, w / 2, y);
      y += lineGap;
    }
    return out;
  }

  function downloadQr() {
    const canvas = qrCanvasRef.current;
    if (!canvas) {
      toast.error("QR code isn't ready yet", { description: "Try again in a moment." });
      return;
    }
    try {
      const target = qrCaption ? captionedCanvas(canvas) ?? canvas : canvas;
      const fileName = qrFileName("png");
      triggerDownload(target.toDataURL("image/png"), fileName);
      flagDownloaded("png", fileName);
    } catch {
      toast.error("Couldn't download the QR code", {
        description: "Long-press or right-click the QR image to save it instead.",
      });
    }
  }

  /** Flattens the QR canvas onto white and saves it as a share-ready JPG. */
  function downloadQrJpg() {
    const canvas = qrCanvasRef.current;
    if (!canvas) {
      toast.error("QR code isn't ready yet", { description: "Try again in a moment." });
      return;
    }
    try {
      const flat = document.createElement("canvas");
      flat.width = canvas.width;
      flat.height = canvas.height;
      const ctx = flat.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      // JPG has no alpha: paint white first so the code never renders on black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(canvas, 0, 0);
      const target = qrCaption ? captionedCanvas(flat) ?? flat : flat;
      const fileName = qrFileName("jpg");
      triggerDownload(target.toDataURL("image/jpeg", 0.92), fileName);
      flagDownloaded("jpg", fileName);
    } catch {
      toast.error("Couldn't download the JPG", {
        description: "Try the PNG download instead.",
      });
    }
  }

  /** Builds a print-ready PDF page (US Letter or A4) with the QR, label and share link. */
  async function downloadQrPdf() {
    const canvas = qrCanvasRef.current;
    if (!canvas) {
      toast.error("QR code isn't ready yet", { description: "Try again in a moment." });
      return;
    }
    setPdfBuilding(true);
    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ unit: "mm", format: qrPdfSize, orientation: qrPdfOrientation });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();

      // Flatten onto white so the code never prints on a transparent/black plate.
      const flat = document.createElement("canvas");
      flat.width = canvas.width;
      flat.height = canvas.height;
      const ctx = flat.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(canvas, 0, 0);

      // Optional premium branding: crimson header band with the label logo and a
      // matching footer rule with contact details.
      const headerH = qrPdfBrand ? (qrPdfOrientation === "landscape" ? 22 : 26) : 0;
      let contentTop = 48;

      if (qrPdfBrand) {
        const logo = await brandLogoDataUrl();
        doc.setFillColor(PDF_BRAND.ink);
        doc.rect(0, 0, pageW, headerH, "F");
        doc.setFillColor(PDF_BRAND.accent);
        doc.rect(0, headerH, pageW, 1.6, "F");

        let textX = 14;
        if (logo) {
          const logoH = headerH - 10;
          try {
            doc.addImage(logo, "PNG", 14, 5, logoH, logoH);
            textX = 14 + logoH + 6;
          } catch {
            /* logo decode failed — fall back to text-only branding */
          }
        }
        doc.setTextColor("#ffffff");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.text(PDF_BRAND.label, textX, headerH / 2, { baseline: "middle" });
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor("#c9ccd2");
        doc.text(PDF_BRAND.tagline, pageW - 14, headerH / 2, {
          align: "right",
          baseline: "middle",
        });
        doc.setTextColor(PDF_BRAND.ink);
        contentTop = headerH + 18;
      }

      doc.setTextColor(qrPdfBrand ? PDF_BRAND.ink : "#000000");
      doc.setFont("courier", "bold");
      doc.setFontSize(16);
      doc.text("HYBRID AI RECORDS", pageW / 2, contentTop, { align: "center" });
      doc.setFont("courier", "normal");
      doc.setFontSize(10);
      doc.text(pkg ? `Order form — ${pkg}` : "Order form", pageW / 2, contentTop + 8, {
        align: "center",
      });

      // Keep the code and its caption inside the page on short landscape pages.
      const qrTop = contentTop + 20;
      const footerH = qrPdfBrand ? 20 : 0;
      const qrMm = Math.max(50, Math.min(110, pageH - qrTop - 40 - footerH));
      doc.addImage(flat.toDataURL("image/png"), "PNG", (pageW - qrMm) / 2, qrTop, qrMm, qrMm);

      doc.setFontSize(11);
      doc.text("Scan to open this order form", pageW / 2, qrTop + qrMm + 14, { align: "center" });
      doc.setFontSize(9);
      const urlLines = doc.splitTextToSize(qrUrl ?? "", pageW - 40) as string[];
      doc.text(urlLines, pageW / 2, qrTop + qrMm + 22, { align: "center" });

      if (qrPdfBrand) {
        doc.setFillColor(PDF_BRAND.accent);
        doc.rect(14, pageH - 16, pageW - 28, 0.8, "F");
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor("#5a606b");
        doc.text(PDF_BRAND.footer, 14, pageH - 10);
        doc.text(new Date().getFullYear().toString(), pageW - 14, pageH - 10, { align: "right" });
      }


      const fileName = qrFileName("pdf");
      doc.save(fileName);
      flagDownloaded("pdf", fileName);
    } catch {
      toast.error("Couldn't build the PDF", {
        description: "Try the PNG download or the print option instead.",
      });
    } finally {
      setPdfBuilding(false);
    }
  }

  /** Serializes the on-screen vector QR at a fixed pixel box, or null if absent. */
  function qrSvgMarkup(px: number) {
    const svg = qrSvgWrapRef.current?.querySelector("svg");
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${px} ${px}`);
    clone.setAttribute("width", String(px));
    clone.setAttribute("height", String(px));
    return new XMLSerializer().serializeToString(clone);
  }

  /** Saves the on-screen vector QR — infinitely scalable for print/flyers. */
  function downloadQrSvg() {
    let objectUrl: string | null = null;
    try {
      // Scale-independent output: keep the viewBox, drop the fixed pixel size.
      const markup = qrSvgMarkup(QR_SIZES[qrSize]);
      if (!markup) {
        toast.error("QR code isn't ready yet", { description: "Try again in a moment." });
        return;
      }
      const doc = `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`;
      const blob = new Blob([doc], { type: "image/svg+xml;charset=utf-8" });
      objectUrl = URL.createObjectURL(blob);
      const fileName = qrFileName("svg");
      triggerDownload(objectUrl, fileName);
      flagDownloaded("svg", fileName);
    } catch {
      toast.error("Couldn't download the SVG", {
        description: "Try the PNG download instead.",
      });
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 10_000);
    }
  }

  /**
   * Prints just the QR code with the share link underneath. Rendered into a
   * hidden iframe so the page layout is untouched and popup blockers (which
   * kill window.open printing) never come into play.
   */
  function printQr() {
    if (printing || qrUrl === null) return;
    const markup = qrSvgMarkup(512);
    if (!markup) {
      setPrintAnnounce("The QR code isn't ready to print yet. Try again in a moment.");
      toast.error("QR code isn't ready yet", { description: "Try again in a moment." });
      return;
    }
    setPrinting(true);
    setPrintAnnounce("Preparing the QR code for printing…");

    const escapeHtml = (value: string) =>
      value.replace(/[&<>"']/g, (ch) =>
        ch === "&"
          ? "&amp;"
          : ch === "<"
            ? "&lt;"
            : ch === ">"
              ? "&gt;"
              : ch === '"'
                ? "&quot;"
                : "&#39;",
      );

    const heading = escapeHtml(shareTitle);
    const caption = pkg
      ? `Scan to open the order form with the ${escapeHtml(pkg)} package preselected.`
      : "Scan to open the Hybrid AI Records order form.";

    const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>${heading} — Share QR</title>
<style>
  @page { margin: 16mm; }
  html, body { background: #fff; color: #000; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
         display: flex; flex-direction: column; align-items: center; gap: 14px;
         padding: 24px; text-align: center; }
  h1 { font-size: 15px; letter-spacing: .16em; text-transform: uppercase; margin: 0; }
  p { font-size: 11px; margin: 0; max-width: 78mm; line-height: 1.6; }
  .url { word-break: break-all; font-size: 11px; }
  svg { width: 82mm; height: 82mm; }
</style></head>
<body>
  <h1>${heading}</h1>
  ${markup}
  <p class="url">${escapeHtml(qrUrl)}</p>
  <p>${caption}</p>
</body></html>`;

    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", "QR code print preview");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;";
    frame.srcdoc = doc;

    const cleanup = () => {
      if (printFrameTimer.current) clearTimeout(printFrameTimer.current);
      printFrameTimer.current = setTimeout(() => frame.remove(), 1000);
    };

    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        if (!win) throw new Error("no frame window");
        win.focus();
        win.print();
        setPrintAnnounce(`Print dialog opened for the QR code and this link: ${qrUrl}`);
        toast.success("QR code sent to print", { description: qrUrl });
      } catch {
        setPrintAnnounce(
          "Printing was blocked by your browser. Download the PNG or SVG and print that instead.",
        );
        toast.error("Couldn't open the print dialog", {
          description: "Download the PNG or SVG and print that instead.",
        });
      } finally {
        setPrinting(false);
        cleanup();
        requestAnimationFrame(() => printBtnRef.current?.focus());
      }
    };

    document.body.appendChild(frame);
  }








  const shareTitle = pkg
    ? `Hybrid AI Records — ${pkg}`
    : "Hybrid AI Records — Start a Track";

  /** Hidden-textarea + execCommand path for browsers without async clipboard. */
  function legacyCopy(url: string) {
    const el = document.createElement("textarea");
    el.value = url;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "0";
    el.style.opacity = "0";
    document.body.appendChild(el);
    const selection = document.getSelection();
    const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    el.select();
    el.setSelectionRange(0, el.value.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(el);
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
    return ok;
  }

  /** Returns true when the URL reached the clipboard by any available means. */
  async function writeToClipboard(url: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        return true;
      }
    } catch {
      // Blocked by permissions policy, insecure context, or a denied prompt.
    }
    return legacyCopy(url);
  }

  async function copyUrl(url: string) {
    if (copying) return;
    setCopying(true);
    // Clear first so a repeated identical outcome still re-announces.
    setCopyAnnounce("");
    let succeeded = false;
    try {
      if (await writeToClipboard(url)) {
        succeeded = true;
        setManualUrl(null);
        setCopied(true);
        // Success wording is announced by the in-button live region; this
        // sibling region carries the detail (which link) and failure guidance.
        setCopyAnnounce(`Copied this link: ${url}`);
        toast.success("Share link copied", { description: url });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
        return;
      }
      // Last resorts: a selectable field, plus prompt() where it's available.
      setCopied(false);
      setManualUrl(url);
      setCopyAnnounce(
        "Copying the share link failed. Your browser blocked clipboard access. Use the link field below the button and press Control or Command plus C to copy it.",
      );
      try {
        window.prompt("Copy this share link:", url);
      } catch {
        // Some embedded webviews disable prompt(); the field below still works.
      }
      toast.message("Copy the link manually", { description: url });
    } finally {
      const hadFocus =
        document.activeElement === copyBtnRef.current || document.activeElement === document.body;
      setCopying(false);
      // Disabling the button while copying drops focus; put it back so keyboard
      // users stay on the control that just announced the result. On failure the
      // manual-copy field claims focus instead, so leave it alone.
      if (succeeded && hadFocus) requestAnimationFrame(() => copyBtnRef.current?.focus());
    }
  }



  async function copy() {
    await copyUrl(shareUrl());
  }

  /**
   * Opens the share link in a new tab so the user can verify what a recipient
   * sees. Popup blockers are the common failure: we surface that clearly
   * instead of leaving the button in a silent no-op state.
   */
  function openShareLink() {
    if (opening) return;
    const url = shareUrl();
    setOpening(true);
    setOpened(false);
    // Clear first so a repeated identical outcome still re-announces.
    setOpenAnnounce("");
    let win: Window | null = null;
    try {
      win = window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      win = null;
    }
    setOpening(false);
    if (win) {
      setOpened(true);
      setOpenAnnounce(`Opened this link in a new tab: ${url}`);
      toast.success("Share link opened in a new tab", { description: url });
      if (openTimer.current) clearTimeout(openTimer.current);
      openTimer.current = setTimeout(() => setOpened(false), 2000);
    } else {
      setOpenAnnounce(
        `Opening the share link failed. Your browser blocked the new tab. Allow pop-ups for this site, or copy the link instead: ${url}`,
      );
      toast.error("Couldn't open the share link", {
        description: "Your browser blocked the new tab — allow pop-ups or copy the link instead.",
      });
    }
    // Keep keyboard users on the control that just announced the result.
    requestAnimationFrame(() => openBtnRef.current?.focus());
  }



  async function share() {
    const url = shareUrl();
    try {
      // Copy first so the link is on the clipboard whichever target they pick.
      await writeToClipboard(url).catch(() => undefined);
      await navigator.share({
        title: shareTitle,
        text: pkg
          ? `Start your ${pkg} release with Hybrid AI Records.`
          : "Start your release with Hybrid AI Records.",
        url,
      });
    } catch (err) {
      // A user-cancelled share sheet is not an error worth surfacing.
      if ((err as Error)?.name === "AbortError") return;
      toast.error("Couldn't open the share sheet", { description: url });
    }
  }

  /**
   * Ctrl/Cmd + C anywhere inside the share controls copies the link, so keyboard
   * users don't have to tab onto the copy button first. Real text selections and
   * the manual-copy field keep the browser's native copy behaviour.
   */
  function onShortcut(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "c" && e.key !== "C") return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim() !== "") return;
    e.preventDefault();
    void copy();
  }

  const kbdCls =
    "rounded-[2px] border border-border bg-background/70 px-1.5 py-0.5 font-mono text-[10px] leading-none text-status-accent";

  return (
    <div className="grid gap-2" onKeyDown={onShortcut}>
      <button
        type="button"
        ref={copyBtnRef}
        onClick={copy}
        disabled={copying}
        aria-busy={copying}
        aria-pressed={copied}
        data-testid="share-link-copy"
        title={`Copy the share link (${modKeyLabel} + C while these controls are focused)`}
        aria-describedby="share-link-shortcut-hint"
        aria-label={`Copy share link to this order form${pkg ? ` with the ${pkg} package preselected` : ""}`}
        className={`${btnCls} disabled:cursor-wait disabled:opacity-60 ${copied ? "border-primary text-status-accent" : ""}`}
      >
        {copying ? (
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden className="shrink-0 animate-spin" />
        ) : copied ? (
          <Check size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
        ) : (
          <Link2 size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
        )}
        {copying ? "Copying…" : copied ? "Link Copied" : "Copy Share Link"}
        <span aria-live="polite" className="sr-only">
          {copying ? "Copying share link" : copied ? "Share link copied to clipboard" : ""}
        </span>
      </button>

      {/* Visible keyboard hint, also referenced by the copy button's aria-describedby. */}
      <p
        id="share-link-shortcut-hint"
        data-testid="share-link-shortcut-hint"
        className="flex flex-wrap items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
      >
        <span>Press</span>
        <kbd className={kbdCls}>{modKeyLabel}</kbd>
        <span aria-hidden>+</span>
        <kbd className={kbdCls}>C</kbd>
        <span>to copy while these controls are focused</span>
      </p>



      {/* Outcome detail for screen readers, adjacent to the copy button. */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="share-link-copy-status"
        className="sr-only"
      >
        {copyAnnounce}
      </span>

      <button
        type="button"
        ref={openBtnRef}
        onClick={openShareLink}
        disabled={opening}
        aria-busy={opening}
        data-testid="share-link-open"
        aria-label={`Open the share link in a new tab${pkg ? ` with the ${pkg} package preselected` : ""}`}
        className={`${btnCls} disabled:cursor-wait disabled:opacity-60 ${opened ? "border-primary text-status-accent" : ""}`}
      >
        {opening ? (
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden className="shrink-0 animate-spin" />
        ) : opened ? (
          <Check size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
        ) : (
          <ExternalLink size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
        )}
        {opening ? "Opening…" : opened ? "Link Opened" : "Open Share Link"}
      </button>

      {/* Outcome detail for screen readers, adjacent to the open button. */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="share-link-open-status"
        className="sr-only"
      >
        {openAnnounce}
      </span>



      {manualUrl && (
        <div
          role="status"
          aria-live="polite"
          data-testid="share-link-fallback"
          className="grid gap-1 border border-primary/60 bg-background/40 p-2"
        >
          <label
            htmlFor="manual-share-link"
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-status-accent"
          >
            Copying is blocked in this browser — press Ctrl/Cmd + C to copy the link below
          </label>

          <input
            id="manual-share-link"
            ref={manualRef}
            readOnly
            value={manualUrl}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
            className="w-full bg-transparent px-2 py-2 font-mono text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </div>
      )}

      <button
        type="button"
        ref={qrToggleRef}
        onClick={toggleQr}
        aria-expanded={qrUrl !== null}
        aria-controls="order-share-qr"
        aria-describedby="order-share-qr-toggle-hint"
        aria-label={`${qrUrl !== null ? "Hide the" : "Show a"} QR code for this order link${pkg ? ` with the ${pkg} package preselected` : ""}`}
        className={btnCls}
      >
        <QrCode size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
        {qrUrl !== null ? "Hide QR Code" : "Show QR Code"}
      </button>
      <span id="order-share-qr-toggle-hint" className="sr-only">
        Opens a panel with a scannable QR code, scan settings and download options for this order
        link.
      </span>

      {/* Announced independently of the panel so both open and close are heard. */}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {qrUrl !== null ? "QR code shown. Press Escape to close it." : ""}
      </span>

      {/* Generation lifecycle: generating → generated → failed (with details). */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="share-link-qr-status"
        className="sr-only"
      >
        {qrStatusMessage}
      </span>


      {qrUrl !== null && (
        <div
          id="order-share-qr"
          ref={qrPanelRef}
          data-testid="share-link-qr"
          role="group"
          aria-roledescription="QR code panel"
          tabIndex={-1}
          aria-label={`QR code for this order link${pkg ? ` with the ${pkg} package preselected` : ""}. Scan it with a phone camera to open the order form.`}
          aria-describedby="order-share-qr-alt"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              closeQr();
              return;
            }
            trapTab(e);
          }}
          className="relative grid justify-items-center gap-2 overflow-hidden border border-border bg-background/40 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {qrError ? (
            <div
              data-testid="share-link-qr-error"
              role="alert"
              aria-atomic="true"
              className="grid w-full justify-items-center gap-3 border border-destructive/50 bg-destructive/10 p-4 text-center"
            >
              <AlertTriangle
                size={20}
                strokeWidth={1.75}
                aria-hidden
                className="shrink-0 text-destructive"
              />
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-foreground">
                QR code unavailable
              </p>
              <p
                id="order-share-qr-error-detail"
                className="max-w-xs text-xs leading-relaxed text-foreground"
              >
                {qrError}
              </p>
              <button
                type="button"
                onClick={retryQr}
                data-testid="share-link-qr-retry"
                aria-label="Retry generating the QR code for this order link"
                aria-describedby="order-share-qr-error-detail"
                className={btnCls}
              >
                <RefreshCw size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
                Retry
              </button>
            </div>
          ) : (
            <QrRenderBoundary
              resetKey={`${qrUrl}|${qrLevel}|${qrAttempt}`}
              onError={(message) => setRenderError(message)}
            >
              <div ref={qrSvgWrapRef} className="bg-white p-3">
                <QRCodeSVG
                  key={`svg-${qrAttempt}`}
                  value={qrUrl}
                  size={QR_SIZES[qrSize]}
                  level={qrLevel}
                  marginSize={0}
                  role="img"
                  aria-label={`QR code for this order link${pkg ? ` with the ${pkg} package preselected` : ""}`}
                  aria-describedby="order-share-qr-alt order-share-qr-url"
                  title={`QR code for ${qrUrl}`}
                />
              </div>

              {/* Off-screen 1024px render so the saved PNG stays print-sharp. */}
              <QRCodeCanvas
                key={`canvas-${qrAttempt}`}
                ref={qrCanvasRef}
                value={qrUrl}
                size={qrPngRes}
                level={qrLevel}
                marginSize={2}
                aria-hidden
                className="pointer-events-none absolute size-px opacity-0"
              />
            </QrRenderBoundary>
          )}

          {/* Text alternative AND live region: re-announced whenever the share
              link changes or generation fails, so the summary is never silent. */}
          <p
            id="order-share-qr-alt"
            data-testid="share-link-qr-alt"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {qrError
              ? `Warning: the QR code could not be generated, so there is nothing to scan. ${qrError} Use the Copy link button instead, or press Retry.`
              : `This QR code contains the share link to the Hybrid AI Records order form${pkg ? `, with the ${pkg} package preselected` : ""}. The full web address it encodes is: ${qrUrl}. If you cannot scan it, use the Copy link button to get the same address as text.`}
          </p>


          {/* Visible, always-present summary of what the QR encodes. It tracks
              the live share URL and flips to a warning if generation fails. */}
          <div
            data-testid="share-link-qr-summary"
            aria-hidden="true"
            className={`w-full border px-3 py-2 font-mono text-[10px] leading-relaxed tracking-[0.08em] ${
              qrError
                ? "border-destructive/60 bg-destructive/10 text-foreground"
                : "border-border bg-background/60 text-muted-foreground"
            }`}
          >
            {qrError ? (
              <>
                <span className="block uppercase tracking-[0.18em] text-foreground">
                  QR unavailable
                </span>
                <span className="mt-1 block break-words normal-case text-foreground">
                  {qrError}
                </span>
                <span className="mt-1 block break-words normal-case text-foreground">
                  Use “Copy link” or press Retry to try again.
                </span>
              </>

            ) : (
              <>
                <span className="block uppercase tracking-[0.18em] text-status-accent">
                  This QR contains your share link
                </span>
                <span className="mt-1 block break-all normal-case text-foreground">{qrUrl}</span>
                {pkg ? (
                  <span className="mt-1 block normal-case">
                    Opens the order form with the {pkg} package preselected.
                  </span>
                ) : null}
              </>
            )}
          </div>




          {/* Scan tuning — bigger + higher recovery scans on more cameras. */}
          <div
            role="group"
            aria-label="QR scan settings"
            className="grid w-full gap-2 sm:grid-cols-2"
          >
            <div className="grid gap-1 text-left">
              <label
                htmlFor="order-share-qr-size"
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
              >
                QR Size
              </label>
              <select
                id="order-share-qr-size"
                data-testid="share-link-qr-size"
                value={qrSize}
                onChange={(e) => changeSize(e.target.value as QrSize)}
                aria-describedby="order-share-qr-size-hint"
                className={selectCls}
              >
                {(Object.keys(QR_SIZES) as QrSize[]).map((key) => (
                  <option key={key} value={key}>
                    {`${key} — ${QR_SIZES[key]}px`}
                  </option>
                ))}
              </select>
              <span id="order-share-qr-size-hint" className="sr-only">
                How large the QR code is drawn on screen and in downloads. Larger codes scan from
                further away.
              </span>
            </div>
            <div className="grid gap-1 text-left">
              <label
                htmlFor="order-share-qr-level"
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
              >
                Error Correction
              </label>
              <select
                id="order-share-qr-level"
                data-testid="share-link-qr-level"
                value={qrLevel}
                onChange={(e) => changeLevel(e.target.value as QrLevel)}
                aria-describedby="order-share-qr-level-hint"
                className={selectCls}
              >
                {(Object.keys(QR_LEVELS) as QrLevel[]).map((key) => (
                  <option key={key} value={key}>
                    {QR_LEVELS[key]}
                  </option>
                ))}
              </select>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Pick <span className="font-semibold text-foreground">High (H)</span> for flyers,
                stickers or low-quality printing — it stays scannable through smudges and glare.
              </p>
              <span id="order-share-qr-level-hint" className="sr-only">
                How much damage or glare the code can survive while still scanning. Higher levels
                fit fewer characters.
              </span>
            </div>
            <div className="grid gap-1 text-left sm:col-span-2">
              <label
                htmlFor="order-share-qr-png-res"
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
              >
                PNG Download Resolution
              </label>
              <select
                id="order-share-qr-png-res"
                data-testid="share-link-qr-png-res"
                value={qrPngRes}
                onChange={(e) => changePngRes(Number(e.target.value) as QrPngRes)}
                aria-describedby="order-share-qr-png-res-hint"
                className={selectCls}
              >
                {QR_PNG_RESOLUTIONS.map((px) => (
                  <option key={px} value={px}>
                    {QR_PNG_RES_LABELS[px]}
                  </option>
                ))}
              </select>
              <span id="order-share-qr-png-res-hint" className="sr-only">
                Pixel width and height of the downloaded PNG file. Higher resolutions stay sharp on
                large prints but make bigger files.
              </span>
            </div>
            <div className="grid gap-1 text-left sm:col-span-2">
              <label
                htmlFor="order-share-qr-pdf-size"
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
              >
                PDF Page Size
              </label>
              <select
                id="order-share-qr-pdf-size"
                data-testid="share-link-qr-pdf-size"
                value={qrPdfSize}
                onChange={(e) => changePdfSize(e.target.value)}
                aria-describedby="order-share-qr-pdf-size-hint"
                className={selectCls}
              >
                {QR_PDF_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {QR_PDF_SIZE_LABELS[size]}
                  </option>
                ))}
              </select>
              <span id="order-share-qr-pdf-size-hint" className="sr-only">
                Paper size used by the print-ready PDF download. Choose A4 for printers outside the
                United States.
              </span>
            </div>
            <div className="grid gap-1 text-left sm:col-span-2">
              <label
                htmlFor="order-share-qr-pdf-orientation"
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
              >
                PDF Orientation
              </label>
              <select
                id="order-share-qr-pdf-orientation"
                data-testid="share-link-qr-pdf-orientation"
                value={qrPdfOrientation}
                onChange={(e) => changePdfOrientation(e.target.value)}
                aria-describedby="order-share-qr-pdf-orientation-hint"
                className={selectCls}
              >
                {QR_PDF_ORIENTATIONS.map((o) => (
                  <option key={o} value={o}>
                    {QR_PDF_ORIENTATION_LABELS[o]}
                  </option>
                ))}
              </select>
              <span id="order-share-qr-pdf-orientation-hint" className="sr-only">
                Page orientation used by the print-ready PDF download. Landscape suits wide handouts
                and slide decks.
              </span>
            </div>
            <div className="sm:col-span-2">
              <label
                htmlFor="order-share-qr-pdf-brand"
                className="flex items-start gap-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
              >
                <input
                  id="order-share-qr-pdf-brand"
                  data-testid="share-link-qr-pdf-brand"
                  type="checkbox"
                  checked={qrPdfBrand}
                  onChange={(e) => changePdfBrand(e.target.checked)}
                  aria-describedby="order-share-qr-pdf-brand-hint"
                  className="mt-0.5 size-3.5 shrink-0 accent-primary"
                />
                Branded PDF header &amp; footer (logo + label)
              </label>
              <span id="order-share-qr-pdf-brand-hint" className="sr-only">
                Adds a Hybrid AI Records logo header band and a contact footer to the downloaded PDF
                page for a premium, print-ready look.
              </span>
            </div>
            <div className="sm:col-span-2">
              <label
                htmlFor="order-share-qr-caption"
                className="flex items-start gap-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
              >
                <input
                  id="order-share-qr-caption"
                  data-testid="share-link-qr-caption"
                  type="checkbox"
                  checked={qrCaption}
                  onChange={(e) => changeCaption(e.target.checked)}
                  aria-describedby="order-share-qr-caption-hint"
                  className="mt-0.5 size-3.5 shrink-0 accent-primary"
                />
                Include caption (label + share link)
              </label>
              <span id="order-share-qr-caption-hint" className="sr-only">
                Adds a printed strip under the QR code in downloaded images with the Hybrid AI
                Records label and the share link, so the image is complete for posting.
              </span>
              {qrCaption ? (
                <fieldset className="mt-2 border-0 p-0">
                  <legend className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Caption link style
                  </legend>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {[
                      { id: "full", label: "Full share URL", short: false },
                      { id: "short", label: "Shortened link", short: true },
                    ].map((opt) => (
                      <label
                        key={opt.id}
                        htmlFor={`order-share-qr-caption-${opt.id}`}
                        className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
                      >
                        <input
                          id={`order-share-qr-caption-${opt.id}`}
                          data-testid={`share-link-qr-caption-${opt.id}`}
                          type="radio"
                          name="order-share-qr-caption-style"
                          checked={qrCaptionShort === opt.short}
                          onChange={() => changeCaptionShort(opt.short)}
                          aria-describedby="order-share-qr-caption-style-hint"
                          className="size-3.5 shrink-0 accent-primary"
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                  <p
                    id="order-share-qr-caption-style-hint"
                    className="mt-1 break-all font-mono text-[10px] normal-case tracking-normal text-muted-foreground/80"
                  >
                    Caption preview: {captionUrlText() || "—"}
                    {qrCaptionShort ? " · the QR still scans to the full link" : ""}
                  </p>
                </fieldset>
              ) : null}
            </div>
          </div>
          <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {`QR code set to ${qrSize} size, ${QR_LEVELS[qrLevel]} error correction, ${qrPngRes} pixel PNG downloads, ${QR_PDF_SIZE_LABELS[qrPdfSize]} ${qrPdfOrientation} PDF pages with branded header and footer ${qrPdfBrand ? "on" : "off"}, caption ${qrCaption ? `on with ${qrCaptionShort ? "shortened link" : "full share URL"}` : "off"}.`}
          </span>





          <p className="text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {qrError ? "Fix the link above, then retry" : "Scan to open this order form on your phone"}
          </p>
          <p
            id="order-share-qr-url"
            data-testid="share-link-qr-url"
            className="w-full break-all text-center font-mono text-[10px] text-muted-foreground"
          >
            {qrUrl}
          </p>
          <div
            role="group"
            aria-label="Download this QR code"
            className="grid w-full gap-2 sm:grid-cols-2"
          >
            <button
              type="button"
              onClick={downloadQr}
              disabled={!qrReady}
              aria-disabled={!qrReady}
              data-testid="share-link-qr-download"
              aria-label={`Download this QR code as a PNG image${pkg ? ` for the ${pkg} package` : ""}`}
              aria-describedby={
                qrReady ? "order-share-qr-url" : "order-share-qr-download-unavailable"
              }
              className={`${btnCls} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground`}
            >
              {qrDownloaded === "png" ? (
                <Check size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              ) : (
                <Download size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              )}
              {qrDownloaded === "png" ? "PNG Saved" : "Download PNG"}
            </button>
            <button
              type="button"
              onClick={downloadQrJpg}
              disabled={!qrReady}
              aria-disabled={!qrReady}
              data-testid="share-link-qr-download-jpg"
              aria-label={`Download this QR code as a JPG image${pkg ? ` for the ${pkg} package` : ""}`}
              aria-describedby={
                qrReady ? "order-share-qr-url" : "order-share-qr-download-unavailable"
              }
              className={`${btnCls} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground`}
            >
              {qrDownloaded === "jpg" ? (
                <Check size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              ) : (
                <ImageDown size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              )}
              {qrDownloaded === "jpg" ? "JPG Saved" : "Download JPG"}
            </button>
            <button
              type="button"
              onClick={downloadQrPdf}
              disabled={!qrReady || pdfBuilding}
              aria-disabled={!qrReady || pdfBuilding}
              aria-busy={pdfBuilding}
              data-testid="share-link-qr-download-pdf"
              aria-label={`Download a print-ready ${qrPdfOrientation} ${QR_PDF_SIZE_LABELS[qrPdfSize]} PDF page with this QR code${pkg ? ` for the ${pkg} package` : ""}`}
              aria-describedby={
                qrReady ? "order-share-qr-url" : "order-share-qr-download-unavailable"
              }
              className={`${btnCls} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground`}
            >
              {pdfBuilding ? (
                <RefreshCw size={14} strokeWidth={1.75} aria-hidden className="shrink-0 animate-spin" />
              ) : qrDownloaded === "pdf" ? (
                <Check size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              ) : (
                <FileText size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              )}
              {pdfBuilding ? "Building PDF…" : qrDownloaded === "pdf" ? "PDF Saved" : "Download PDF"}
            </button>
            <button
              type="button"
              onClick={downloadQrSvg}
              disabled={!qrReady}
              aria-disabled={!qrReady}
              data-testid="share-link-qr-download-svg"
              aria-label={`Download this QR code as a scalable SVG vector file${pkg ? ` for the ${pkg} package` : ""}`}
              aria-describedby={
                qrReady ? "order-share-qr-url" : "order-share-qr-download-unavailable"
              }
              className={`${btnCls} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground`}
            >
              {qrDownloaded === "svg" ? (
                <Check size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              ) : (
                <Download size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              )}
              {qrDownloaded === "svg" ? "SVG Saved" : "Download SVG"}
            </button>
            <button
              type="button"
              ref={printBtnRef}
              onClick={printQr}
              disabled={!qrReady || printing}
              aria-disabled={!qrReady || printing}
              aria-busy={printing}
              data-testid="share-link-qr-print"
              aria-label={`Print this QR code with the share link underneath${pkg ? ` for the ${pkg} package` : ""}`}
              aria-describedby={
                qrReady ? "order-share-qr-print-hint" : "order-share-qr-download-unavailable"
              }
              className={`${btnCls} sm:col-span-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground`}
            >
              {printing ? (
                <RefreshCw size={14} strokeWidth={1.75} aria-hidden className="shrink-0 animate-spin" />
              ) : (
                <Printer size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              )}
              {printing ? "Preparing Print…" : "Print QR Code"}
            </button>
            <span id="order-share-qr-print-hint" className="sr-only">
              Opens your printer dialog with a clean page containing only the QR code and the share
              link printed underneath it.
            </span>
            <span id="order-share-qr-download-unavailable" className="sr-only">
              Downloads are unavailable until the QR code generates successfully.
            </span>
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-testid="share-link-qr-print-status"
              className="sr-only"
            >
              {printAnnounce}
            </span>
          </div>


          {/* Copies the exact URL the QR encodes, without leaving the panel. */}
          <button
            type="button"
            onClick={() => copyUrl(qrUrl)}
            disabled={copying}
            aria-busy={copying}
            aria-pressed={copied}
            data-testid="share-link-qr-copy-url"
            aria-describedby="order-share-qr-url"
            aria-label="Copy the share URL encoded in this QR code to the clipboard"
            className={`${btnCls} disabled:cursor-wait disabled:opacity-60 ${copied ? "border-primary text-status-accent" : ""}`}
          >
            {copying ? (
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden className="shrink-0 animate-spin" />
            ) : copied ? (
              <Check size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
            ) : (
              <Link2 size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
            )}
            {copying ? "Copying…" : copied ? "URL Copied" : "Copy Share URL"}
          </button>

          <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {qrDownloaded ? `QR code ${qrDownloaded.toUpperCase()} downloaded` : ""}
          </span>


          <button
            type="button"
            onClick={closeQr}
            aria-label="Close the QR code and return to the share buttons"
            className={btnCls}
          >
            Close QR Code
          </button>
        </div>
      )}


      {canShare && (
        <button
          type="button"
          onClick={share}
          aria-label={`Share this order link${pkg ? ` for the ${pkg} package` : ""} using your device's share sheet`}
          className={btnCls}
        >
          <Share2 size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
          Share
        </button>
      )}
    </div>
  );
}

