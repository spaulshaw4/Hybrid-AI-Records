import logoAsset from "@/assets/hybrid-ai-records-logo.png.asset.json";

/**
 * Branding applied to the generated receipt PDF (logo, colors, layout).
 * Persisted per-device so the artist only sets it up once.
 */
export type ReceiptLayout = "band" | "letterhead" | "minimal";

export type ReceiptBranding = {
  labelName: string;
  tagline: string;
  /** Data URL of the logo drawn in the receipt header (null = no logo). */
  logoDataUrl: string | null;
  /** Hex accent used for rules, reference code and headings. */
  accent: string;
  /** Hex color of the header band / heading text. */
  ink: string;
  layout: ReceiptLayout;
  footerNote: string;
};

export const DEFAULT_BRANDING: ReceiptBranding = {
  labelName: "HYBRID AI RECORDS LLC",
  tagline: "Track Application — Submission Recap",
  logoDataUrl: null,
  accent: "#e11d2e",
  ink: "#16181c",
  layout: "band",
  footerNote:
    "Questions? Email Hybrid.AI.Records@proton.me — no payment is taken until you approve an invoice.",
};

export const ACCENT_PRESETS: Array<{ label: string; accent: string; ink: string }> = [
  { label: "Crimson (default)", accent: "#e11d2e", ink: "#16181c" },
  { label: "Patriot blue", accent: "#1d4ed8", ink: "#0f1b3d" },
  { label: "Gold master", accent: "#c9a84c", ink: "#0d0d0d" },
  { label: "Steel mono", accent: "#4a5568", ink: "#1a1a1a" },
];

export const LAYOUT_OPTIONS: Array<{ value: ReceiptLayout; label: string; hint: string }> = [
  { value: "band", label: "Solid band", hint: "Full-width dark header with logo on the left." },
  { value: "letterhead", label: "Letterhead", hint: "Centered logo and label name on white." },
  { value: "minimal", label: "Minimal", hint: "Small logo, thin accent rule, lots of white space." },
];

/** The label's default logo, served from the CDN. */
export const DEFAULT_LOGO_URL: string = logoAsset.url;

const KEY = "hybrid-receipt-branding-v1";

export function readBranding(): ReceiptBranding {
  if (typeof window === "undefined") return DEFAULT_BRANDING;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_BRANDING;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_BRANDING, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return DEFAULT_BRANDING;
  }
}

export function saveBranding(branding: ReceiptBranding) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(branding));
  } catch {
    /* storage full/blocked — branding is cosmetic, never block the download */
  }
}

export function resetBranding() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Reads a File (PNG/JPEG) into a data URL usable by jsPDF. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.readAsDataURL(file);
  });
}

/** Fetches the label's default logo and converts it to a data URL. */
export async function loadDefaultLogo(): Promise<string> {
  const res = await fetch(DEFAULT_LOGO_URL);
  if (!res.ok) throw new Error("Could not load the label logo.");
  const blob = await res.blob();
  return await fileToDataUrl(new File([blob], "logo.png", { type: blob.type || "image/png" }));
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return [225, 29, 46];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
