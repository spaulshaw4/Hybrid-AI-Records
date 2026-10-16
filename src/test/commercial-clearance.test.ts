// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SendBody = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
};

type CertificateModel = {
  filename: string;
  isrc: string;
  artist: string;
  banner: string;
  docRef: string;
  tier: string;
};

const { send, state, getUserById, renderClearanceCertificatePdf } = vi.hoisted(() => ({
  send: vi.fn(async (_body: SendBody, _opts?: { idempotencyKey?: string }) => ({
    data: { id: "email_test_1" },
    error: null,
  })),
  renderClearanceCertificatePdf: vi.fn(async (_model: CertificateModel) => Buffer.from("%PDF-1.4\n")),
  getUserById: vi.fn(async (_userId: string) => ({
    data: {
      user: {
        email: "session@example.com",
        user_metadata: { display_name: "Nia" } as Record<string, unknown>,
      },
    },
    error: null,
  })),
  state: {
    updateError: null as { message: string } | null,
    updates: [] as Array<{ table: string; payload: unknown }>,
  },
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

vi.mock("@/lib/vault-admin.server", () => ({
  vaultAdminClient: () => ({
    from: (table: string) => ({
      update: (payload: unknown) => {
        state.updates.push({ table, payload });
        const chain = {
          eq() {
            return chain;
          },
          then(
            onFulfilled: (value: { error: { message: string } | null }) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) {
            return Promise.resolve({ error: state.updateError }).then(onFulfilled, onRejected);
          },
        };
        return chain;
      },
    }),
  }),
}));

vi.mock("@/lib/clearance-certificate.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clearance-certificate.server")>(
    "@/lib/clearance-certificate.server",
  );
  return { ...actual, renderClearanceCertificatePdf };
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { admin: { getUserById } },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  },
}));

import { finalizeTrackClearance } from "@/lib/commercial-clearance.server";
import {
  buildClearanceCertificateModel,
  clearanceCertificateFilename,
  loadClearanceLogo,
} from "@/lib/clearance-certificate.server";
import { CLEARANCE_EMAIL_FROM, resetClearanceEmailLedger } from "@/lib/clearance-email.server";

const FROM = "Hybrid AI Records <clearance@hybrid-ai-records.com>";
const CREATED = new Date("2026-10-11T20:58:00.000Z");
const SIGN_OFF = `Warm regards,
Stephen P. Shaw
Executive Producer & CEO
Hybrid AI Records LLC
hybrid-ai-records.com`;

const SUBJECT_1 = "Commercial Clearance & Rights Grant — Glass Harbor | Hybrid AI Records";
const SUBJECT_2 = "Studio Authenticity & Compliance Notice — Glass Harbor | Hybrid AI Records";
const SUBJECT_3 = "Certified Master Clearance & Rights Grant — Glass Harbor | Hybrid AI Records";
const CERT_NAME = "Glass_Harbor_Clearance_Certificate.pdf";

function complete(extra: Record<string, unknown> = {}) {
  return finalizeTrackClearance({
    userId: "session-user",
    taskId: "task-1",
    title: "Glass Harbor",
    lyrics: "I wrote this line",
    instrumental: false,
    lyricsOrigin: "user",
    to: "artist@example.com",
    artistName: "Mina",
    createdAt: CREATED,
    masterId: "task-1",
    trackKey: "task-1",
    ...extra,
  });
}

function lastMail(): SendBody {
  const body = send.mock.calls.at(-1)?.[0];
  if (!body) throw new Error("expected a clearance email");
  return body;
}

function lastCertificate(): CertificateModel {
  const model = renderClearanceCertificatePdf.mock.calls.at(-1)?.[0];
  if (!model) throw new Error("expected a clearance certificate");
  return model;
}

function expectAttachment(filename: string) {
  const body = lastMail();
  expect(body.attachments).toHaveLength(1);
  expect(body.attachments?.[0]?.filename).toBe(filename);
  expect(Buffer.isBuffer(body.attachments?.[0]?.content)).toBe(true);
  expect((body.attachments?.[0]?.content.length ?? 0) > 0).toBe(true);
  expect(body.text).toContain(`Attached Deliverable: ${filename}`);
  expect(body.html).toContain(`Attached Deliverable: ${filename}`);
  expect(lastCertificate().filename).toBe(filename);
}

describe("commercial clearance letters", () => {
  const originalKey = process.env.RESEND_API_KEY;

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    send.mockClear();
    renderClearanceCertificatePdf.mockClear();
    getUserById.mockClear();
    state.updates.length = 0;
    state.updateError = null;
    resetClearanceEmailLedger();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
  });

  it("stores instrumental clearance and sends letter 1", async () => {
    const result = await complete({
      instrumental: true,
      lyrics: "still here",
      lyricsOrigin: "synthetic",
      vocalId: "stem-1",
      trackKey: "task-inst",
      masterId: "task-inst",
      taskId: "task-inst",
    });

    expect(result).toEqual({ tier: "instrumental", emailed: true });
    expect(state.updates).toEqual([
      { table: "vaulted_tracks", payload: { clearance_tier: "instrumental" } },
    ]);
    expect(send).toHaveBeenCalledOnce();
    const body = lastMail();
    expect(body.from).toBe(FROM);
    expect(CLEARANCE_EMAIL_FROM).toBe(FROM);
    expect(body.to).toBe("artist@example.com");
    expect(body.subject).toBe(SUBJECT_1);
    expect(body.subject).toContain("—");
    expect(body.text).toContain("Assigned ISRC: Pending assignment");
    expect(body.html).toContain("Assigned ISRC: Pending assignment");
    expect(body.text).toContain("Master Vault ID: task-inst");
    expect(body.text).toContain("Clearance Level: Tier 1 — Full Commercial & Distribution Clearance");
    expect(body.text).toContain("Master Clearance Certificate & Grant of Rights");
    expectAttachment(CERT_NAME);
    expect(lastCertificate().artist).toBe("Enterprise Studio License");
    expect(body.text.startsWith("Dear Creator,\n")).toBe(true);
    expect(body.text.endsWith(SIGN_OFF)).toBe(true);
    expect(body.text).not.toMatch(/[A-Z]{2}[A-Z0-9]{3}\d{7}/);
    expect(body.text).not.toContain("{{");
    expect(body.html).not.toMatch(/<img\b/i);
    expect(body.text).not.toMatch(/wavespeed|replicate|claude|gemini|aimusic|\bfish\b|supabase/i);
  });

  it("stores verified_vocal and sends letter 3 for user lyrics", async () => {
    const result = await complete({ trackKey: "task-user", masterId: "vault-row-3", taskId: "task-user" });

    expect(result).toEqual({ tier: "verified_vocal", emailed: true });
    expect(state.updates[0]?.payload).toEqual({ clearance_tier: "verified_vocal" });
    const body = lastMail();
    expect(body.from).toBe(FROM);
    expect(body.subject).toBe(SUBJECT_3);
    expect(body.text).toContain("Registered Author / Lyricist: Mina");
    expect(body.text).toContain("Assigned ISRC: Pending assignment");
    expect(body.html).toContain("Assigned ISRC:");
    expect(body.text).toContain("Master Vault ID: vault-row-3");
    expect(body.text).toContain("Certified Commercial Master & Publishing Clearance");
    expect(body.text).toContain("Clearance Level: Tier 3 — Certified Original Master (Unconditional Commercial Rights)");
    expectAttachment(CERT_NAME);
    expect(lastCertificate().artist).toBe("Mina");
    expect(body.text.endsWith(SIGN_OFF)).toBe(true);
    expect(body.text).not.toMatch(/[A-Z]{2}[A-Z0-9]{3}\d{7}/);
  });

  it("includes a real ISRC on letters 1 and 3 only when one was already stored", async () => {
    await complete({
      instrumental: true,
      isrc: "GBARL2400001",
      trackKey: "task-isrc",
      taskId: "task-isrc",
      masterId: "task-isrc",
    });
    const letter1 = lastMail();
    expect(letter1.text).toContain("Assigned ISRC: GBARL2400001");
    expect(letter1.text).not.toContain("Pending assignment");

    resetClearanceEmailLedger();
    await complete({
      lyricsOrigin: "user",
      isrc: "GBARL2400001",
      trackKey: "task-isrc-3",
      taskId: "task-isrc-3",
      masterId: "task-isrc-3",
    });
    expect(lastMail().text).toContain("Assigned ISRC: GBARL2400001");
  });

  it("stores ai_voice and sends letter 2 for synthetic lyrics, with no ISRC line", async () => {
    const result = await complete({
      lyricsOrigin: "synthetic",
      lyrics: "[Verse]\nghost line",
      isrc: "GBARL2400001",
      trackKey: "task-synth",
      taskId: "task-synth",
      masterId: "task-synth",
    });

    expect(result).toEqual({ tier: "ai_voice", emailed: true });
    expect(state.updates[0]?.payload).toEqual({ clearance_tier: "ai_voice" });
    const body = lastMail();
    expect(body.from).toBe(FROM);
    expect(body.subject).toBe(SUBJECT_2);
    expect(body.text).not.toMatch(/ISRC/);
    expect(body.html).not.toMatch(/ISRC/);
    expect(body.text).not.toContain("GBARL2400001");
    expect(body.text).toContain("Tier 2 — Personal & Social License (DSP Distribution Restricted)");
    expect(body.text).toContain("this track is not cleared for commercial DSP streaming networks");
    expectAttachment(CERT_NAME);
    expect(lastCertificate().isrc).toBe("EXEMPT / NON-COMMERCIAL ARCHIVE");
    expect(lastCertificate().artist).toBe("Mina");
    expect(body.text.endsWith(SIGN_OFF)).toBe(true);
    expect(body.html).not.toMatch(/<img\b/i);
  });

  it("treats a human vocal stem as letter 3 even when the lyrics are synthetic", async () => {
    const result = await complete({
      lyricsOrigin: "synthetic",
      lyrics: "hi",
      vocalId: "vocal_stephen_oct5_master",
      trackKey: "task-stem",
      taskId: "task-stem",
      masterId: "task-stem",
    });
    expect(result.tier).toBe("verified_vocal");
    expect(lastMail().subject).toBe(SUBJECT_3);
    expect(lastMail().text).toContain("Assigned ISRC:");
  });

  it("does not send a second email when the same track id is finalized again", async () => {
    const first = await complete({ trackKey: "track-once", taskId: "track-once", masterId: "track-once" });
    const second = await complete({ trackKey: "track-once", taskId: "track-once", masterId: "track-once" });
    expect(first.emailed).toBe(true);
    expect(second.emailed).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(lastMail().from).toBe(FROM);
  });

  it("emails the session user and uses Creator when no display name is stored", async () => {
    getUserById.mockResolvedValueOnce({
      data: { user: { email: "session@example.com", user_metadata: {} } },
      error: null,
    });
    const result = await complete({
      to: undefined,
      artistName: undefined,
      trackKey: "task-session",
      taskId: "task-session",
      masterId: "task-session",
    });
    expect(result.emailed).toBe(true);
    expect(getUserById).toHaveBeenCalledWith("session-user");
    const body = lastMail();
    expect(body.to).toBe("session@example.com");
    expect(body.from).toBe(FROM);
    expect(body.text).toContain("Registered Author / Lyricist: Creator");
  });

  it("still sends the letter when the clearance column is missing", async () => {
    state.updateError = { message: "Could not find the clearance_tier column of vaulted_tracks" };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await complete({ trackKey: "task-missing-col", taskId: "task-missing-col", masterId: "task-missing-col" });
    expect(result).toEqual({ tier: "verified_vocal", emailed: true });
    expect(send).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith("[clearance] clearance_tier column update failed");
    errorSpy.mockRestore();
  });

  it("skips the send when Resend is not configured and still records the tier", async () => {
    delete process.env.RESEND_API_KEY;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await complete({ trackKey: "task-nokey", taskId: "task-nokey", masterId: "task-nokey" });
    expect(result).toEqual({ tier: "verified_vocal", emailed: false });
    expect(send).not.toHaveBeenCalled();
    expect(state.updates[0]?.payload).toEqual({ clearance_tier: "verified_vocal" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("uses Untitled in the subject when the stored title is blank", async () => {
    await complete({
      title: "   ",
      instrumental: true,
      trackKey: "task-blank",
      taskId: "task-blank",
      masterId: "task-blank",
    });
    expect(lastMail().subject).toBe(
      "Commercial Clearance & Rights Grant — Untitled | Hybrid AI Records",
    );
    expectAttachment("Clearance_Certificate.pdf");
  });

  it("uses the same sanitized filename in the letter and the attachment", async () => {
    await complete({
      title: "Track: Live?",
      instrumental: true,
      trackKey: "task-punct",
      taskId: "task-punct",
      masterId: "task-punct",
    });
    expectAttachment("Track__Live__Clearance_Certificate.pdf");
  });
});

describe("clearance certificate registry", () => {
  it("sanitizes filenames and maps tier registry fields", () => {
    expect(clearanceCertificateFilename("Glass Harbor")).toBe("Glass_Harbor_Clearance_Certificate.pdf");
    expect(clearanceCertificateFilename("Track: Live?")).toBe("Track__Live__Clearance_Certificate.pdf");
    expect(clearanceCertificateFilename("")).toBe("Clearance_Certificate.pdf");

    const tier2 = buildClearanceCertificateModel({
      tier: "ai_voice",
      trackTitle: "Glass Harbor",
      masterId: "task-synth",
      isrc: "GBARL2400001",
      createdAt: CREATED,
      artistName: "Mina",
    });
    expect(tier2.isrc).toBe("EXEMPT / NON-COMMERCIAL ARCHIVE");
    expect(tier2.artist).toBe("Mina");
    expect(tier2.banner).toBe("TIER 02 // AI SYNTHETIC VOICE \u2014 CREATOR SANDBOX (DSP RESTRICTED)");
    expect(tier2.banner).not.toMatch(/[\u25A0\u25B2\u2605]/);

    const tier1 = buildClearanceCertificateModel({
      tier: "instrumental",
      trackTitle: "Glass Harbor",
      masterId: "vaultA1B2C3",
      isrc: "",
      createdAt: CREATED,
      artistName: "Mina",
    });
    expect(tier1.artist).toBe("Enterprise Studio License");
    expect(tier1.isrc).toBe("Pending assignment");
    expect(tier1.docRef).toBe("DOC-REF: HAR-2026-T1-A1B2C3");
    expect(tier1.timestamp).toBe("2026-10-11T20:58:00.000Z");
    expect(tier1.trackTitle).toBe("GLASS HARBOR");

    const shortId = buildClearanceCertificateModel({
      tier: "ai_voice",
      trackTitle: "Glass Harbor",
      masterId: "ab",
      createdAt: CREATED,
      artistName: "Mina",
    });
    expect(shortId.docRef).toBe("DOC-REF: HAR-2026-T2-ab");
  });

  it("reads the header lockup from disk and does not fetch it", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("certificate must not fetch"));
    try {
      const logo = loadClearanceLogo();
      const fromDisk = readFileSync(join(process.cwd(), "public", "brand", "lockup-usa-512.png"));
      expect(createHash("sha256").update(logo).digest("hex")).toBe(
        createHash("sha256").update(fromDisk).digest("hex"),
      );
      expect(logo.length).toBeGreaterThan(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("renders a one-page certificate that starts with %PDF", async () => {
    const actual = await vi.importActual<typeof import("@/lib/clearance-certificate.server")>(
      "@/lib/clearance-certificate.server",
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("certificate must not fetch"));
    try {
      const model = actual.buildClearanceCertificateModel({
        tier: "instrumental",
        trackTitle: "Glass Harbor",
        masterId: "vaultA1B2C3",
        isrc: null,
        createdAt: CREATED,
        artistName: "Mina",
      });
      const bytes = await actual.renderClearanceCertificatePdf(model);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(100);
      const pages = bytes.toString("latin1").match(/\/Type\s*\/Page(?!s)/g);
      expect(pages?.length).toBe(1);
      const requested = fetchSpy.mock.calls.map((call) => String(call[0]));
      expect(requested.some((url) => /^https?:/i.test(url))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  }, 20000);
});
