import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCertificateOfCreationPdf } from "@/lib/certificate-of-creation.server";
import { sendTrackCompletionEmail } from "@/lib/resend.server";

const original = process.env.RESEND_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  if (original === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = original;
});

describe("buildCertificateOfCreationPdf", () => {
  it("returns a PDF buffer with the track title and seal filename", () => {
    const cert = buildCertificateOfCreationPdf({
      trackTitle: "A Map of Chaos",
      creatorName: "Stephen P. Shaw",
      reference: "track-123",
      generatedAt: new Date("2026-08-24T12:00:00Z"),
    });
    expect(cert.filename).toBe("certificate-of-creation-a-map-of-chaos.pdf");
    expect(cert.bytes.byteLength).toBeGreaterThan(500);
    expect(cert.contentBase64.length).toBeGreaterThan(100);
    expect(cert.bytes.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });
});

describe("sendTrackCompletionEmail", () => {
  it("is a quiet no-op when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendTrackCompletionEmail({
      to: "artist@example.com",
      trackId: "t1",
      trackTitle: "Neon Lights",
      creatorName: "Artist",
      masterDownloadUrl: "https://cdn.example/master.mp3",
    });
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(spy).toHaveBeenCalled();
  });

  it("refuses a recipient without an @", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const result = await sendTrackCompletionEmail({
      to: "not-an-email",
      trackId: "t1",
      trackTitle: "Neon Lights",
      creatorName: "Artist",
      masterDownloadUrl: "https://cdn.example/master.mp3",
    });
    expect(result).toEqual({ ok: false, reason: "no_recipient" });
  });

  it("refuses when the master download URL is empty", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const result = await sendTrackCompletionEmail({
      to: "artist@example.com",
      trackId: "t1",
      trackTitle: "Neon Lights",
      creatorName: "Artist",
      masterDownloadUrl: "  ",
    });
    expect(result).toEqual({ ok: false, reason: "no_master_url" });
  });
});
