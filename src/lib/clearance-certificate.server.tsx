/**
 * In-memory Master Clearance certificate.
 * White studio cue sheet. The header mark is read from disk; nothing is fetched.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Document, Font, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";

export type ClearanceCertificateTier = "instrumental" | "ai_voice" | "verified_vocal";

/**
 * Header lockup used by BrandEagle (`/brand/lockup-usa-512.png`).
 * Square RGBA PNG, so a 44×44 box keeps the aspect ratio.
 */
const LOGO_FILE = "lockup-usa-512.png";

/**
 * Helvetica's built-in WinAnsi set has no glyphs for ■ ▲ ★.
 * The banner keeps TIER 01 / TIER 02 / TIER 03 and omits the symbol
 * so the PDF does not draw a missing-glyph box.
 */
const TIER_BANNER: Record<ClearanceCertificateTier, string> = {
  instrumental: "TIER 01 // INSTRUMENTAL MASTER \u2014 UNCONDITIONAL COMMERCIAL CLEARANCE",
  ai_voice: "TIER 02 // AI SYNTHETIC VOICE \u2014 CREATOR SANDBOX (DSP RESTRICTED)",
  verified_vocal: "TIER 03 // CERTIFIED ORIGINAL MASTER \u2014 HUMAN LYRIC AUTHORSHIP VERIFIED",
};

const DISCLAIMER: Record<ClearanceCertificateTier, string> = {
  instrumental:
    "Because this production is an instrumental work generated under our enterprise studio license, it is completely free of third-party vocal liabilities and cleared for unconditional commercial exploitation.",
  ai_voice:
    "Because we are in your corner as an artist-first platform, we will not lead you into that trap. As detailed in Section II of your attached certificate, this track is not cleared for commercial DSP streaming networks. Hybrid AI Records LLC accepts no legal or financial liability for takedowns, distributor penalties, or rejected ingestions resulting from unauthorized third-party submissions of synthetic vocal masters.",
  verified_vocal:
    "Your attached document provides complete legal backing across two formal pillars:\nSection I: Proof of Studio Authenticity \u2014 Verifying the recording was produced under official, authorized Hybrid AI Records infrastructure.\nSection II: Grant of Commercial Distribution Rights \u2014 Granting unconditional authority to monetize, stream, sync, and distribute this master worldwide.",
};

Font.registerHyphenationCallback((word) => [word]);

const styles = StyleSheet.create({
  page: {
    backgroundColor: "#FFFFFF",
    color: "#0A0A0A",
    paddingTop: 28,
    paddingBottom: 28,
    paddingHorizontal: 32,
    fontFamily: "Helvetica",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#111827",
    paddingBottom: 8,
  },
  logo: {
    height: 44,
    width: 44,
    marginRight: 10,
  },
  headerCopy: {
    flex: 1,
    paddingRight: 8,
  },
  identifier: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7.5,
    letterSpacing: 0.7,
    color: "#0A0A0A",
  },
  subbar: {
    marginTop: 3,
    fontFamily: "Helvetica",
    fontSize: 6.5,
    letterSpacing: 0.45,
    color: "#0A0A0A",
  },
  docRef: {
    width: 132,
    fontFamily: "Courier",
    fontSize: 7,
    color: "#0A0A0A",
    textAlign: "right",
  },
  banner: {
    marginTop: 12,
    backgroundColor: "#000000",
    paddingVertical: 7,
    paddingHorizontal: 8,
  },
  bannerText: {
    fontFamily: "Helvetica-Bold",
    fontSize: 8,
    color: "#FFFFFF",
    textAlign: "center",
    letterSpacing: 0.15,
  },
  table: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: "#111827",
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
    minHeight: 22,
  },
  rowLast: {
    flexDirection: "row",
    minHeight: 22,
  },
  label: {
    width: 176,
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRightWidth: 1,
    borderRightColor: "#E5E7EB",
    fontFamily: "Courier",
    fontSize: 8,
    color: "#0A0A0A",
  },
  value: {
    flex: 1,
    paddingVertical: 5,
    paddingHorizontal: 6,
    fontFamily: "Courier",
    fontSize: 8,
    color: "#0A0A0A",
  },
  valueBold: {
    flex: 1,
    paddingVertical: 5,
    paddingHorizontal: 6,
    fontFamily: "Courier-Bold",
    fontSize: 8,
    color: "#0A0A0A",
  },
  disclaimer: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: "#111827",
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  disclaimerBody: {
    fontFamily: "Helvetica",
    fontSize: 8,
    lineHeight: 1.35,
    color: "#0A0A0A",
  },
  footer: {
    marginTop: 16,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#111827",
    paddingTop: 10,
  },
  signName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    color: "#0A0A0A",
  },
  signMeta: {
    marginTop: 2,
    fontFamily: "Helvetica",
    fontSize: 8,
    color: "#0A0A0A",
  },
  stamp: {
    width: 176,
    borderWidth: 1,
    borderColor: "#111827",
    padding: 4,
  },
  stampInner: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingVertical: 5,
    paddingHorizontal: 4,
    alignItems: "center",
  },
  stampText: {
    fontFamily: "Helvetica-Bold",
    fontSize: 6.5,
    letterSpacing: 0.35,
    textAlign: "center",
    color: "#0A0A0A",
  },
});

export type ClearanceCertificateModel = {
  tier: ClearanceCertificateTier;
  filename: string;
  docRef: string;
  banner: string;
  trackTitle: string;
  artist: string;
  masterId: string;
  isrc: string;
  timestamp: string;
  disclaimer: string;
};

/** Every character outside [A-Za-z0-9_-] becomes an underscore. */
export function clearanceCertificateFilename(trackTitle: string): string {
  const sanitized = trackTitle.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!sanitized) return "Clearance_Certificate.pdf";
  return `${sanitized}_Clearance_Certificate.pdf`;
}

export function clearanceDocRef(masterId: string, tier: ClearanceCertificateTier, createdAt: Date): string {
  const tierNum = tier === "instrumental" ? 1 : tier === "ai_voice" ? 2 : 3;
  const year = createdAt.getUTCFullYear();
  const short = masterId.trim().slice(-6);
  return short ? `DOC-REF: HAR-${year}-T${tierNum}-${short}` : `DOC-REF: HAR-${year}-T${tierNum}`;
}

export function buildClearanceCertificateModel(input: {
  tier: ClearanceCertificateTier;
  trackTitle: string;
  masterId: string;
  isrc?: string | null;
  createdAt: Date;
  artistName?: string | null;
}): ClearanceCertificateModel {
  const isrcValue = typeof input.isrc === "string" ? input.isrc.trim() : "";
  const artistName = input.artistName?.trim() || "Creator";
  return {
    tier: input.tier,
    filename: clearanceCertificateFilename(input.trackTitle),
    docRef: clearanceDocRef(input.masterId, input.tier, input.createdAt),
    banner: TIER_BANNER[input.tier],
    trackTitle: (input.trackTitle.trim() || "Untitled").toUpperCase(),
    artist: input.tier === "instrumental" ? "Enterprise Studio License" : artistName,
    masterId: input.masterId.trim(),
    isrc: input.tier === "ai_voice" ? "EXEMPT / NON-COMMERCIAL ARCHIVE" : isrcValue || "Pending assignment",
    timestamp: input.createdAt.toISOString(),
    disclaimer: DISCLAIMER[input.tier],
  };
}

export function resolveClearanceLogoPath(): string {
  const candidates = [
    join(process.cwd(), "public", "brand", LOGO_FILE),
    join(process.cwd(), ".output", "public", "brand", LOGO_FILE),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Hybrid AI Records logo file is missing");
  return found;
}

/** Local PNG bytes. Callers pass this buffer to Image; no URL is requested. */
export function loadClearanceLogo(): Buffer {
  return readFileSync(resolveClearanceLogoPath());
}

function RegistryRow({
  label,
  value,
  bold = false,
  last = false,
}: {
  label: string;
  value: string;
  bold?: boolean;
  last?: boolean;
}) {
  return (
    <View style={last ? styles.rowLast : styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={bold ? styles.valueBold : styles.value}>{value}</Text>
    </View>
  );
}

function ClearanceCertificateDocument({
  model,
  logoSource,
}: {
  model: ClearanceCertificateModel;
  logoSource: Buffer;
}) {
  return (
    <Document>
      <Page size="LETTER" wrap={false} style={styles.page}>
        <View style={styles.headerRow}>
          <Image src={logoSource} style={styles.logo} />
          <View style={styles.headerCopy}>
            <Text style={styles.identifier}>HYBRID AI RECORDS LLC // EXECUTIVE CLEARANCE REGISTRY</Text>
            <Text style={styles.subbar}>STUDIO INFRASTRUCTURE // MASTER CLEARANCE & METADATA REGISTRY</Text>
          </View>
          <Text style={styles.docRef}>{model.docRef}</Text>
        </View>

        <View style={styles.banner}>
          <Text style={styles.bannerText}>{model.banner}</Text>
        </View>

        <View style={styles.table}>
          <RegistryRow label="Track Title" value={model.trackTitle} bold />
          <RegistryRow label="Registered Artist / Lyricist" value={model.artist} />
          <RegistryRow label="Master Vault ID" value={model.masterId} />
          <RegistryRow label="Assigned ISRC" value={model.isrc} />
          <RegistryRow label="Timestamp" value={model.timestamp} last />
        </View>

        <View style={styles.disclaimer}>
          <Text style={styles.disclaimerBody}>{model.disclaimer}</Text>
        </View>

        <View style={styles.footer}>
          <View>
            <Text style={styles.signName}>Stephen P. Shaw</Text>
            <Text style={styles.signMeta}>Executive Producer & CEO</Text>
            <Text style={styles.signMeta}>Hybrid AI Records LLC</Text>
          </View>
          <View style={styles.stamp}>
            <View style={styles.stampInner}>
              <Text style={styles.stampText}>CERTIFIED STUDIO MASTER</Text>
              <Text style={styles.stampText}>// HYBRID AI RECORDS</Text>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}

export async function renderClearanceCertificatePdf(model: ClearanceCertificateModel): Promise<Buffer> {
  const logoSource = loadClearanceLogo();
  const rendered = await renderToBuffer(
    <ClearanceCertificateDocument model={model} logoSource={logoSource} />,
  );
  return Buffer.from(rendered);
}
