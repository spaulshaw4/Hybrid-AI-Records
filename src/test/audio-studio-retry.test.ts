import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("AudioStudio retry banner", () => {
  const source = readFileSync(join(process.cwd(), "src/components/AudioStudio.tsx"), "utf8");

  it("alerts a failed generation and names the retry control", () => {
    expect(source).toMatch(/role="alert"/);
    expect(source).toContain('aria-label="Retry generation"');
    expect(source).toContain("handleRetry");
  });

  it("keeps the decorative sync mark out of the accessible name", () => {
    expect(source).toMatch(/<CloudCheck className="size-4" aria-hidden="true" \/>/);
    // The radio SyncBadge is its own interactive chip — never nest it in Retry.
    expect(source).not.toMatch(/aria-label="Retry generation"[\s\S]{0,400}<SyncBadge/);
  });

  it("keeps Retry a sibling of the failure alert", () => {
    const start = source.indexOf("{!busy && rollbackNotice");
    const banner = source.slice(start, start + 1800);
    const alertAt = banner.indexOf('role="alert"');
    const retryAt = banner.indexOf('aria-label="Retry generation"');
    expect(alertAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(alertAt);
    expect(banner.slice(alertAt, retryAt)).toContain("</div>");
  });
});
