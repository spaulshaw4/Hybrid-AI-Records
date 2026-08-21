import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DivisionCrest } from "@/components/DivisionCrest";
import { crestFor } from "@/lib/divisions";
import { resetDivisionNames } from "@/lib/division-settings";
import { CATALOG_RELEASES } from "@/routes/index";

const release = { title: "Sample Track", artist: "Sample Artist", division: "jester" as const };

beforeEach(() => {
  window.localStorage.clear();
  resetDivisionNames();
});

describe("division crest keyboard navigation", () => {
  it("is reachable with Tab and exposes a visible focus ring", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">before</button>
        <DivisionCrest release={release} />
        <button type="button">after</button>
      </>,
    );

    const badge = screen.getByRole("img");
    await user.tab();
    expect(screen.getByRole("button", { name: "before" })).toHaveFocus();

    await user.tab();
    expect(badge).toHaveFocus();
    expect(badge).toHaveAttribute("tabindex", "0");
    expect(badge.className).toContain("focus-visible:ring-2");

    await user.tab();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });

  it("reveals the tooltip on keyboard focus and on hover", async () => {
    const user = userEvent.setup();
    render(<DivisionCrest release={release} />);

    const badge = screen.getByRole("img");
    const tooltip = screen.getByTestId("division-tooltip");

    // Focus path: focus-within variants drive the reveal for keyboard users.
    expect(tooltip.className).toContain("group-focus-within/crest:opacity-100");
    expect(tooltip.className).toContain("group-focus-within/crest:translate-y-0");
    // Hover path: same reveal for pointer users.
    expect(tooltip.className).toContain("group-hover/crest:opacity-100");
    expect(tooltip.className).toContain("group-hover/crest:translate-y-0");
    // Hidden by default and never steals pointer events.
    expect(tooltip.className).toContain("opacity-0");
    expect(tooltip.className).toContain("pointer-events-none");
    // Respects reduced-motion preferences.
    expect(tooltip.className).toContain("motion-reduce:transition-none");

    await user.tab();
    expect(badge).toHaveFocus();
    expect(badge.parentElement?.contains(tooltip)).toBe(true);

    await user.hover(badge);
    expect(tooltip).toBeInTheDocument();
  });

  it("keeps the tooltip inside the focusable group so focus never escapes", () => {
    render(<DivisionCrest release={release} />);
    const badge = screen.getByRole("img");
    expect(badge.className).toContain("group/crest");
    expect(badge).toContainElement(screen.getByTestId("division-tooltip"));
  });
});

describe("division crest screen-reader behavior", () => {
  it("announces one accessible name and hides duplicate visual text", () => {
    render(<DivisionCrest release={release} />);
    const crest = crestFor(release);

    const badge = screen.getByRole("img", {
      name: `${crest.alt}. ${release.title} by ${release.artist}.`,
    });
    expect(badge).toBeInTheDocument();

    // The tooltip is the badge's description (role=tooltip + aria-describedby),
    // and the mobile-only duplicate text stays hidden from AT.
    const tooltip = screen.getByTestId("division-tooltip");
    expect(tooltip).toHaveAttribute("role", "tooltip");
    expect(badge).toHaveAttribute("aria-describedby", tooltip.id);
    expect(screen.getByTestId("division-label-mobile")).toHaveAttribute("aria-hidden", "true");
    // Decorative artwork: empty alt plus aria-hidden, no second announcement.
    const img = badge.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("img").length).toBe(1);
  });

  it("gives every catalog release a unique, descriptive accessible name", () => {
    const names = new Set<string>();
    for (const r of CATALOG_RELEASES) {
      const { unmount } = render(<DivisionCrest release={r} />);
      const name = screen.getByRole("img").getAttribute("aria-label")!;
      expect(name).toContain(crestFor(r).label);
      expect(name).toContain(r.title);
      expect(name).toContain(r.artist);
      names.add(name);
      unmount();
    }
    expect(names.size).toBe(CATALOG_RELEASES.length);
  });
});
