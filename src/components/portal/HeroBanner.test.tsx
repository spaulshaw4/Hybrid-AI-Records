import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HeroBanner } from "@/components/portal/HeroBanner";

describe("HeroBanner", () => {
  it("stacks RAW WORDS, REAL MUSIC, then GLOBAL IMPACT in red, white, and blue", () => {
    render(<HeroBanner />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.className).toContain("font-extrabold");
    expect(heading.className).toContain("text-4xl");
    expect(heading.className).toContain("sm:text-5xl");

    const lines = heading.querySelectorAll(":scope > span");
    expect(Array.from(lines).map((line) => line.textContent?.trim())).toEqual([
      "RAW WORDS.",
      "REAL MUSIC.",
      "GLOBAL IMPACT.",
    ]);
    expect(lines[0]?.className).toContain("text-red-600");
    expect(lines[0]?.className).toContain("drop-shadow-[0_0_12px_rgba(239,68,68,0.4)]");
    expect(lines[1]?.className).toContain("text-white");
    expect(lines[1]?.className).toContain("drop-shadow-[0_0_12px_rgba(255,255,255,0.3)]");
    expect(lines[2]?.className).toContain("text-blue-500");
    expect(lines[2]?.className).toContain("drop-shadow-[0_0_12px_rgba(59,130,246,0.4)]");
    expect(heading.innerHTML).not.toContain("hero-line-");
    expect(heading.innerHTML).not.toContain("#ff3344");
    expect(heading.innerHTML).not.toContain("#2563eb");
  });
});
