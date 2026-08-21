import { beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import axe from "axe-core";
import { DivisionCrest } from "@/components/DivisionCrest";
import { ContactModal } from "@/components/ContactModal";
import { resetDivisionNames } from "@/lib/division-settings";
import { CATALOG_RELEASES } from "@/routes/index";
import type { Division } from "@/lib/divisions";

const DIVISIONS: Division[] = ["jester", "lithuania", "nigeria", "usa"];

/** Runs axe-core against a container and returns the violation list. */
async function violationsIn(container: HTMLElement) {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    rules: {
      // jsdom has no layout/paint, so contrast cannot be evaluated here.
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  return results.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n) => n.html) }));
}

beforeEach(() => {
  window.localStorage.clear();
  resetDivisionNames();
});

describe("axe-core: division crest tooltip markup", () => {
  it.each(DIVISIONS)("has zero violations for the %s crest", async (division) => {
    const { container } = render(
      <DivisionCrest release={{ title: "Sample Track", artist: "Sample Artist", division }} />,
    );
    expect(await violationsIn(container)).toEqual([]);
  });

  it("wires aria-describedby to a role=tooltip element containing the division name", () => {
    const { container, getByRole } = render(
      <DivisionCrest release={{ title: "Sample Track", artist: "Sample Artist", division: "jester" }} />,
    );

    const badge = getByRole("img");
    const describedBy = badge.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const tooltip = container.querySelector(`#${CSS.escape(describedBy!)}`)!;
    expect(tooltip).toBeTruthy();
    expect(tooltip.getAttribute("role")).toBe("tooltip");
    expect(tooltip.textContent?.trim()).toBe("The Jester AI Legacy Records Division");
    expect(tooltip.getAttribute("aria-hidden")).toBeNull();
  });

  it("gives each crest in a list a unique tooltip id (no duplicate-id-aria)", async () => {
    const { container } = render(
      <ul>
        {CATALOG_RELEASES.map((r) => (
          <li key={r.id}>
            <DivisionCrest release={r} />
          </li>
        ))}
      </ul>,
    );

    const ids = Array.from(container.querySelectorAll('[role="tooltip"]')).map((n) => n.id);
    expect(ids).toHaveLength(CATALOG_RELEASES.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await violationsIn(container)).toEqual([]);
  });

  it("has zero violations for the full catalog crest grid", async () => {
    const { container } = render(
      <div>
        {CATALOG_RELEASES.map((r) => (
          <DivisionCrest key={r.id} release={r} />
        ))}
      </div>,
    );
    expect(await violationsIn(container)).toEqual([]);
  });

  it("has zero violations for division branding inside the contact modal", async () => {
    const { baseElement } = render(<ContactModal open onClose={() => {}} />);
    expect(await violationsIn(baseElement as HTMLElement)).toEqual([]);
  });
});
