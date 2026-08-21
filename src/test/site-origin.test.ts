import { describe, expect, it } from "vitest";
import {
  allowedOrigin,
  allowedSiteUrl,
  defaultSiteOrigin,
} from "@/lib/site-origin.server";

/**
 * The allowlist guards every URL we hand to a third party: Stripe checkout
 * return URLs and emailed draft-resume links. A regression here is an open
 * redirect, so the blocked cases below are the security contract.
 */

const APPROVED_ORIGINS = [
  "https://hybrid-ai-records.com",
  "https://www.hybrid-ai-records.com",
  "https://hybrid-ai-studio.lovable.app",
  "https://id-preview--2ca5e428-hybrid-ai.lovable.app",
  "https://project--hybrid-ai-dev.lovable.app",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

const BLOCKED_CANDIDATES = [
  // Wholly foreign hosts
  "https://evil.com",
  "https://evil.com/hybrid-ai-records.com",
  // Suffix / prefix confusion against the exact hosts
  "https://hybrid-ai-records.com.evil.com",
  "https://evil-hybrid-ai-records.com",
  "https://nothybrid-ai-records.com",
  "https://hybrid-ai-records.com.co",
  // Lovable-domain confusion: right suffix, wrong project marker
  "https://someone-else.lovable.app",
  "https://hybrid-ai.lovable.app.evil.com",
  // Right project marker but not a lovable.app host
  "https://hybrid-ai.evil.app",
  // Userinfo trick: real host is evil.com
  "https://hybrid-ai-records.com@evil.com/",
  // Insecure transport on public hosts
  "http://hybrid-ai-records.com",
  "http://hybrid-ai-studio.lovable.app",
  // Non-HTTP schemes
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "ftp://hybrid-ai-records.com",
  // Protocol-relative and bare paths are not absolute URLs
  "//evil.com",
  "/?resume=token",
  "hybrid-ai-records.com",
  // Malformed input
  "",
  "   ",
  "not a url",
];

describe("defaultSiteOrigin", () => {
  it("is the canonical production origin", () => {
    expect(defaultSiteOrigin()).toBe("https://hybrid-ai-records.com");
  });

  it("is itself on the allowlist", () => {
    expect(allowedOrigin(defaultSiteOrigin())).toBe(defaultSiteOrigin());
  });
});

describe("allowedOrigin — approved targets", () => {
  it.each(APPROVED_ORIGINS)("allows %s", (origin) => {
    expect(allowedOrigin(origin)).toBe(origin);
  });

  it("normalizes to the origin, dropping path, query and hash", () => {
    expect(
      allowedOrigin("https://hybrid-ai-records.com/checkout?x=1#frag"),
    ).toBe("https://hybrid-ai-records.com");
  });

  it("ignores host casing", () => {
    expect(allowedOrigin("https://HYBRID-AI-RECORDS.COM")).toBe(
      "https://hybrid-ai-records.com",
    );
  });

  it("keeps explicit ports on localhost", () => {
    expect(allowedOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });
});

describe("allowedOrigin — blocked targets", () => {
  it.each(BLOCKED_CANDIDATES)("blocks %s", (candidate) => {
    expect(allowedOrigin(candidate)).toBeNull();
  });

  it("blocks missing input", () => {
    expect(allowedOrigin(undefined)).toBeNull();
    expect(allowedOrigin(null)).toBeNull();
  });

  it("never returns a non-allowlisted origin for any blocked candidate", () => {
    for (const candidate of BLOCKED_CANDIDATES) {
      const result = allowedOrigin(candidate);
      expect(result === null || APPROVED_ORIGINS.includes(result)).toBe(true);
    }
  });
});

describe("allowedSiteUrl", () => {
  it("preserves the full path and query of an approved URL", () => {
    const url = "https://hybrid-ai-records.com/?resume=abc123&step=2";
    expect(allowedSiteUrl(url)).toBe(url);
  });

  it("allows approved preview and localhost deep links", () => {
    expect(allowedSiteUrl("https://hybrid-ai-studio.lovable.app/receipts")).toBe(
      "https://hybrid-ai-studio.lovable.app/receipts",
    );
    expect(allowedSiteUrl("http://localhost:8080/status?ref=HAR-ABC123")).toBe(
      "http://localhost:8080/status?ref=HAR-ABC123",
    );
  });

  it.each(BLOCKED_CANDIDATES)("blocks %s", (candidate) => {
    expect(allowedSiteUrl(candidate)).toBeNull();
  });

  it("blocks missing input", () => {
    expect(allowedSiteUrl(undefined)).toBeNull();
    expect(allowedSiteUrl(null)).toBeNull();
  });

  it("blocks an off-site URL that merely mentions an approved host", () => {
    expect(
      allowedSiteUrl("https://evil.com/redirect?to=https://hybrid-ai-records.com"),
    ).toBeNull();
  });
});
