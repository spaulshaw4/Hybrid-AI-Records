import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DivisionCrest } from "@/components/DivisionCrest";
import { ContactModal } from "@/components/ContactModal";
import { resolveDivision, type Division } from "@/lib/divisions";
import { resetDivisionNames } from "@/lib/division-settings";
import { CATALOG_RELEASES } from "@/routes/index";

/**
 * Visual regression snapshots: we serialize the rendered markup (structure +
 * every Tailwind class) for the DivisionCrest badge so any accidental styling
 * drift — spacing, sizes, colors, tooltip behaviour — fails the suite.
 * Asset URLs are normalized so re-uploading artwork doesn't churn snapshots.
 */
const normalize = (el: HTMLElement) =>
  el.outerHTML
    .replace(/src="[^"]*"/g, 'src="[asset]"')
    .replace(/srcset="[^"]*"/g, 'srcset="[asset]"')
    // React's useId output varies with render order — keep snapshots stable.
    .replace(/crest-tooltip-[^"]*/g, "crest-tooltip-[id]")
    .replace(/\s+/g, " ")
    .trim();

const DIVISIONS: Division[] = ["jester", "lithuania", "nigeria", "usa"];

beforeEach(() => {
  window.localStorage.clear();
  resetDivisionNames();
});

describe("DivisionCrest visual snapshots", () => {
  it.each(DIVISIONS)("matches the %s crest styling", (division) => {
    const { container } = render(
      <DivisionCrest release={{ title: "Sample Track", artist: "Sample Artist", division }} />,
    );
    expect(normalize(container.firstElementChild as HTMLElement)).toMatchSnapshot();
  });

  it.each(CATALOG_RELEASES.map((r) => [r.title, r] as const))(
    "matches catalog card crest for %s",
    (_title, release) => {
      render(<DivisionCrest release={release} />);
      const crest = screen.getByTestId("division-crest");
      expect({
        division: resolveDivision(release),
        mobileLabel: screen.getByTestId("division-label-mobile").textContent,
        tooltip: screen.getByTestId("division-tooltip").textContent,
        ariaLabel: screen.getByRole("img").getAttribute("aria-label"),
        markup: normalize(crest),
      }).toMatchSnapshot();
    },
  );
});

describe("ContactModal division styling snapshots", () => {
  it("matches the contact roster division labels and classes", () => {
    const { container } = render(<ContactModal open onClose={() => {}} />);
    const divisionNodes = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='contact-division']"));
    const source = divisionNodes.length
      ? divisionNodes
      : Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
          /Division/i.test(el.textContent ?? "") && el.children.length === 0,
        );

    expect(source.map((el) => ({ text: el.textContent?.trim(), className: el.className }))).toMatchSnapshot();
  });
});
