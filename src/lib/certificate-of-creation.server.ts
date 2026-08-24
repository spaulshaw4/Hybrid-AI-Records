/**
 * Server-side Certificate of Creation PDF for completed studio masters.
 * Used only by the silent completion email — never shown as an in-app modal.
 */
import { jsPDF } from "jspdf";
import { hexToRgb } from "@/lib/receipt-branding";

export type CertificateOfCreationInput = {
  trackTitle: string;
  creatorName: string;
  generatedAt?: Date;
  /** Optional short reference (track id). */
  reference?: string | null;
};

const ACCENT = hexToRgb("#e11d2e");
const INK = hexToRgb("#16181c");
const MUTED: [number, number, number] = [110, 116, 126];
const CREAM: [number, number, number] = [250, 248, 244];

function slugifyFilename(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "track";
}

function formatCertificateDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/** Draws the Hybrid AI Records circular seal. */
function drawSeal(doc: jsPDF, cx: number, cy: number, radius: number): void {
  doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.setLineWidth(2.2);
  doc.circle(cx, cy, radius, "S");
  doc.setLineWidth(0.8);
  doc.circle(cx, cy, radius - 6, "S");

  doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("HYBRID AI RECORDS", cx, cy - 4, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
  doc.text("OFFICIAL SEAL", cx, cy + 8, { align: "center" });
}

/**
 * Builds a Certificate of Creation PDF and returns base64 content for Resend.
 */
export function buildCertificateOfCreationPdf(input: CertificateOfCreationInput): {
  filename: string;
  contentBase64: string;
  bytes: Buffer;
} {
  const generatedAt = input.generatedAt ?? new Date();
  const trackTitle = input.trackTitle.trim() || "Untitled Track";
  const creatorName = input.creatorName.trim() || "Hybrid AI Artist";

  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "landscape" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 36;

  // Cream field + double crimson frame
  doc.setFillColor(CREAM[0], CREAM[1], CREAM[2]);
  doc.rect(0, 0, pageW, pageH, "F");

  doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.setLineWidth(3);
  doc.rect(margin, margin, pageW - margin * 2, pageH - margin * 2, "S");
  doc.setLineWidth(1);
  doc.rect(margin + 8, margin + 8, pageW - (margin + 8) * 2, pageH - (margin + 8) * 2, "S");

  const centerX = pageW / 2;
  let y = margin + 56;

  doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("HYBRID AI RECORDS LLC", centerX, y, { align: "center" });
  y += 28;

  doc.setTextColor(INK[0], INK[1], INK[2]);
  doc.setFontSize(28);
  doc.text("Certificate of Creation", centerX, y, { align: "center" });
  y += 18;

  doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.setLineWidth(1.5);
  doc.line(centerX - 90, y, centerX + 90, y);
  y += 36;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
  doc.text("This certifies that the following hybrid music work was created", centerX, y, {
    align: "center",
  });
  y += 16;
  doc.text("through vision, craft, and dedication at Hybrid AI Records.", centerX, y, {
    align: "center",
  });
  y += 42;

  doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
  doc.setFontSize(10);
  doc.text("TRACK TITLE", centerX, y, { align: "center" });
  y += 22;
  doc.setTextColor(INK[0], INK[1], INK[2]);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  const titleLines = doc.splitTextToSize(trackTitle, pageW - margin * 4);
  doc.text(titleLines, centerX, y, { align: "center" });
  y += titleLines.length * 24 + 18;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
  doc.text("CREATOR", centerX, y, { align: "center" });
  y += 20;
  doc.setTextColor(INK[0], INK[1], INK[2]);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(creatorName, centerX, y, { align: "center" });
  y += 32;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
  doc.text("GENERATION DATE", centerX, y, { align: "center" });
  y += 18;
  doc.setTextColor(INK[0], INK[1], INK[2]);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(formatCertificateDate(generatedAt), centerX, y, { align: "center" });

  drawSeal(doc, pageW - margin - 70, pageH - margin - 70, 42);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
  const footer = input.reference
    ? `Certificate reference ${input.reference} · Hybrid AI Records`
    : "Hybrid AI Records · Official Certificate of Creation";
  doc.text(footer, margin + 24, pageH - margin - 20);

  const arrayBuffer = doc.output("arraybuffer");
  const bytes = Buffer.from(arrayBuffer);
  const filename = `certificate-of-creation-${slugifyFilename(trackTitle)}.pdf`;

  return {
    filename,
    contentBase64: bytes.toString("base64"),
    bytes,
  };
}
