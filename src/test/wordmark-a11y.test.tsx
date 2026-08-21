import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import axe from "axe-core";
import { Wordmark, WORDMARK_LINK } from "@/components/Wordmark";

/**
 * Accessibility contract for the brand lockup.
 *
 * The logo appears twice per page (header + footer) inside links, so the
 * rules that matter are: the link exposes exactly one accessible name, the
 * mark's alt text does not duplicate the visible lettering, and the shared
 * link class always carries a visible keyboard focus ring.
 */

async function violationsIn(container: HTMLElement) {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    rules: {
      // jsdom has no layout/paint: contrast is covered by the Playwright suite.
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  return results.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n) => n.html) }));
}

function renderLink(props: Parameters<typeof Wordmark>[0] = {}) {
  return render(
    <a href="#top" aria-label="Hybrid AI Records — back to top" className={WORDMARK_LINK}>
      <Wordmark {...props} />
    </a>,
  );
}

describe("Wordmark accessible name", () => {
  it("exposes a single descriptive name on the wrapping link", () => {
    const { getByRole } = renderLink({ interactive: true });
    const link = getByRole("link", { name: "Hybrid AI Records — back to top" });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("#top");
  });

  it("keeps the mark decorative when the lettering is visible", () => {
    const { container } = renderLink({ showText: true });
    const img = container.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    // Decorative images must not surface as an img role.
    expect(container.querySelectorAll('img[role="img"]').length).toBe(0);
  });

  it("falls back to alt text when the lettering is hidden", () => {
    const { container } = renderLink({ showText: false });
    const img = container.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("Hybrid AI Records");
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });

  it("omits the mark when showMark is false", () => {
    const { container } = renderLink({ showMark: false, showText: true });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent?.replace(/\s+/g, " ").trim()).toBe("HYBRID AI RECORDS");
  });
});

describe("Wordmark focus ring", () => {
  it("declares a visible focus-visible ring offset from the background", () => {
    expect(WORDMARK_LINK).toContain("focus-visible:ring-2");
    expect(WORDMARK_LINK).toContain("focus-visible:ring-primary");
    expect(WORDMARK_LINK).toContain("focus-visible:ring-offset-2");
    expect(WORDMARK_LINK).toContain("focus-visible:ring-offset-background");
    // outline-none is only safe because a ring replaces it.
    expect(WORDMARK_LINK).toContain("outline-none");
  });

  it("is reachable by keyboard (no negative tabindex, native anchor)", () => {
    const { getByRole } = renderLink();
    const link = getByRole("link");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("tabindex")).toBeNull();
    link.focus();
    expect(document.activeElement).toBe(link);
  });
});

describe("axe-core: wordmark link markup", () => {
  it.each([true, false])("has zero violations with showText=%s", async (showText) => {
    const { container } = renderLink({ showText, interactive: true });
    expect(await violationsIn(container)).toEqual([]);
  });
});
