import { afterEach, describe, expect, it, vi } from "vitest";
import { auditRedirect, resolveOriginWithAudit } from "@/lib/site-origin.server";

function capture(level: "info" | "warn") {
  return vi.spyOn(console, level).mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auditRedirect", () => {
  it("logs allowed decisions at info level with structured fields", () => {
    const info = capture("info");
    auditRedirect({
      surface: "stripe_return_url",
      candidate: "https://hybrid-ai-records.com/checkout/return",
      resolved: "https://hybrid-ai-records.com/checkout/return",
      allowed: true,
    });
    expect(info).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(info.mock.calls[0]![0] as string);
    expect(entry.event).toBe("redirect_decision");
    expect(entry.outcome).toBe("allowed");
    expect(entry.surface).toBe("stripe_return_url");
    expect(entry.candidate).toBe("https://hybrid-ai-records.com/checkout/return");
    expect(typeof entry.at).toBe("string");
  });

  it("logs blocked decisions at warn level", () => {
    const warn = capture("warn");
    auditRedirect({
      surface: "draft_resume_link",
      candidate: "https://evil.example.com",
      resolved: "https://hybrid-ai-records.com",
      allowed: false,
    });
    const entry = JSON.parse(warn.mock.calls[0]![0] as string);
    expect(entry.outcome).toBe("blocked");
    expect(entry.candidate).toBe("https://evil.example.com/");
  });

  it("redacts query strings and userinfo so tokens never reach logs", () => {
    const warn = capture("warn");
    auditRedirect({
      surface: "draft_resume_link",
      candidate: "https://user:pass@evil.example.com/x?resume=SECRET_TOKEN#frag",
      resolved: null,
      allowed: false,
    });
    const entry = JSON.parse(warn.mock.calls[0]![0] as string);
    expect(entry.candidate).not.toContain("SECRET_TOKEN");
    expect(entry.candidate).not.toContain("pass");
    expect(entry.candidate).toContain("(userinfo-stripped)");
    expect(entry.candidate).toContain("?(query-redacted)");
    expect(entry.resolved).toBeNull();
  });

  it("marks unparseable and empty candidates without throwing", () => {
    const warn = capture("warn");
    auditRedirect({ surface: "stripe_return_url", candidate: "not a url", resolved: null, allowed: false });
    auditRedirect({ surface: "stripe_return_url", candidate: undefined, resolved: null, allowed: false });
    expect(JSON.parse(warn.mock.calls[0]![0] as string).candidate).toContain("(unparseable)");
    expect(JSON.parse(warn.mock.calls[1]![0] as string).candidate).toBe("(empty)");
  });

  it("includes caller context fields", () => {
    const info = capture("info");
    auditRedirect({
      surface: "stripe_return_url",
      candidate: "https://hybrid-ai-records.com",
      resolved: "https://hybrid-ai-records.com",
      allowed: true,
      context: { priceId: "foundation", environment: "live" },
    });
    const entry = JSON.parse(info.mock.calls[0]![0] as string);
    expect(entry.priceId).toBe("foundation");
    expect(entry.environment).toBe("live");
  });
});

describe("resolveOriginWithAudit", () => {
  it("returns the trusted origin and logs it as allowed", () => {
    const info = capture("info");
    const result = resolveOriginWithAudit("https://hybrid-ai-records.com/apply", "draft_resume_link");
    expect(result).toEqual({ origin: "https://hybrid-ai-records.com", allowed: true });
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("falls back to the canonical origin and logs a block", () => {
    const warn = capture("warn");
    const result = resolveOriginWithAudit("https://hybrid-ai-records.com.evil.io", "draft_resume_link");
    expect(result).toEqual({ origin: "https://hybrid-ai-records.com", allowed: false });
    expect(JSON.parse(warn.mock.calls[0]![0] as string).outcome).toBe("blocked");
  });

  it("treats a missing origin as a fallback, not a trusted value", () => {
    capture("warn");
    expect(resolveOriginWithAudit(undefined, "stripe_return_url").allowed).toBe(false);
  });
});
