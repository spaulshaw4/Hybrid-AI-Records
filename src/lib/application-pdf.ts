import { jsPDF } from "jspdf";
import {
  DEFAULT_BRANDING,
  hexToRgb,
  readBranding,
  type ReceiptBranding,
} from "@/lib/receipt-branding";

export type RecapTimelineEntry = { label: string; at: string };

export type RecapPdfInput = {
  reference: string | null;
  artist: string;
  email: string;
  packageLabel: string;
  link: string;
  notes: string;
  acknowledged: boolean;
  attachment: {
    name: string;
    sizeLabel: string;
    typeLabel: string;
    formatLabel: string;
    durationLabel: string;
  } | null;
  /** Stage-by-stage timestamps captured during the submission run. */
  timeline: RecapTimelineEntry[];
  submittedAt: Date;
  /** Label branding overrides; falls back to the saved/default branding. */
  branding?: ReceiptBranding;
};


const MUTED: [number, number, number] = [110, 116, 126];


/** Builds a printable recap of a submitted application and returns the filename. */
export function buildApplicationPdf(input: RecapPdfInput): { doc: jsPDF; filename: string } {
  const brand: ReceiptBranding = input.branding ?? (typeof window !== "undefined" ? readBranding() : DEFAULT_BRANDING);
  const CRIMSON = hexToRgb(brand.accent);
  const INK = hexToRgb(brand.ink);

  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 54;
  const maxW = pageW - margin * 2;
  let y = margin;

  const ensureRoom = (needed: number) => {
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const drawLogo = (x: number, top: number, size: number) => {
    if (!brand.logoDataUrl) return false;
    try {
      const fmt = brand.logoDataUrl.includes("image/jpeg") ? "JPEG" : "PNG";
      doc.addImage(brand.logoDataUrl, fmt, x, top, size, size, undefined, "FAST");
      return true;
    } catch {
      return false;
    }
  };

  // Header — three layout treatments
  if (brand.layout === "band") {
    doc.setFillColor(INK[0], INK[1], INK[2]);
    doc.rect(0, 0, pageW, 96, "F");
    const hasLogo = drawLogo(margin, 22, 52);
    const textX = hasLogo ? margin + 68 : margin;
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(brand.labelName, textX, 46);
    doc.setFillColor(CRIMSON[0], CRIMSON[1], CRIMSON[2]);
    doc.rect(textX, 56, 42, 3, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(210, 214, 220);
    doc.text(brand.tagline, textX, 78);
    y = 130;
  } else if (brand.layout === "letterhead") {
    const size = 56;
    const hasLogo = drawLogo(pageW / 2 - size / 2, margin - 12, size);
    y = margin - 12 + (hasLogo ? size + 24 : 8);
    doc.setTextColor(INK[0], INK[1], INK[2]);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(17);
    doc.text(brand.labelName, pageW / 2, y, { align: "center" });
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text(brand.tagline, pageW / 2, y, { align: "center" });
    y += 14;
    doc.setFillColor(CRIMSON[0], CRIMSON[1], CRIMSON[2]);
    doc.rect(pageW / 2 - 30, y, 60, 2.5, "F");
    y += 34;
  } else {
    const hasLogo = drawLogo(margin, margin - 6, 30);
    const textX = hasLogo ? margin + 42 : margin;
    doc.setTextColor(INK[0], INK[1], INK[2]);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(brand.labelName, textX, margin + 10);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text(brand.tagline, textX, margin + 24);
    y = margin + 40;
    doc.setDrawColor(CRIMSON[0], CRIMSON[1], CRIMSON[2]);
    doc.setLineWidth(1.5);
    doc.line(margin, y, margin + maxW, y);
    y += 26;
  }


  // Reference + timestamp
  doc.setTextColor(...MUTED);
  doc.setFontSize(9);
  doc.text(`Submitted ${input.submittedAt.toLocaleString()}`, margin, y);
  y += 16;
  if (input.reference) {
    doc.setTextColor(...CRIMSON);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`Reference code: ${input.reference}`, margin, y);
    y += 22;
  }

  const heading = (text: string) => {
    ensureRoom(40);
    y += 8;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...INK);
    doc.text(text.toUpperCase(), margin, y);
    y += 6;
    doc.setDrawColor(...CRIMSON);
    doc.setLineWidth(1);
    doc.line(margin, y, margin + maxW, y);
    y += 16;
  };

  const row = (label: string, value: string) => {
    const labelW = 130;
    const lines = doc.splitTextToSize(value || "—", maxW - labelW) as string[];
    ensureRoom(lines.length * 14 + 6);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    doc.text(label, margin, y);
    doc.setTextColor(...INK);
    doc.text(lines, margin + labelW, y);
    y += lines.length * 14 + 6;
  };

  heading("Project details");
  row("Artist / band", input.artist);
  row("Reply-to email", input.email);
  row("Package", input.packageLabel);
  row("Reference link", input.link);
  row("Policy acknowledged", input.acknowledged ? "Yes" : "Not required");

  heading("Attachments");
  if (input.attachment) {
    row("Filename", input.attachment.name);
    row("Size", input.attachment.sizeLabel);
    row("Detected type", input.attachment.typeLabel);
    row("Format", input.attachment.formatLabel);
    row("Duration", input.attachment.durationLabel);
  } else {
    row("Files", "No file attached with this submission.");
  }

  if (input.timeline.length) {
    heading("Submission timeline");
    input.timeline.forEach((entry) => row(entry.label, entry.at));
  }


  if (input.notes.trim()) {
    heading("Notes");
    const lines = doc.splitTextToSize(input.notes.trim(), maxW) as string[];
    ensureRoom(lines.length * 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(lines, margin, y);
    y += lines.length * 14 + 6;
  }

  heading("What happens next");
  [
    "1. Review (1–2 business days) — our team listens to your material and checks lyrics against our content policy.",
    "2. Confirmation email — if approved, we email your production slot and invoice.",
    "3. Production begins once the invoice is paid, with updates through each revision round.",
  ].forEach((step) => {
    const lines = doc.splitTextToSize(step, maxW) as string[];
    ensureRoom(lines.length * 14 + 6);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(lines, margin, y);
    y += lines.length * 14 + 6;
  });

  ensureRoom(40);
  y += 10;
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(
    brand.footerNote,
    margin,
    y,
    { maxWidth: maxW },
  );

  const slug =
    (input.reference || input.artist || "application")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "application";

  return { doc, filename: `hybrid-ai-records-recap-${slug}.pdf` };
}
