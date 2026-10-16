import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children?: React.ReactNode; to?: string }) => (
    <a href={to ?? "/"} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouterState: (opts?: { select?: (state: unknown) => unknown }) => {
    const state = { location: { pathname: "/", search: {} } };
    return opts?.select ? opts.select(state) : state;
  },
}));

import { MobileNav } from "@/components/SiteNav";

const LABELS = [
  "CREATE YOUR TRACK",
  "CATALOG & MERCH",
  "PLANS & TOKENS",
  "HYBRID AI RADIO",
  "DISTRIBUTION & VIDEO PACKAGES",
];

describe("SiteNav render", () => {
  it("renders the five portal labels without a missing SITE_NAV reference", () => {
    expect(() => render(<MobileNav />)).not.toThrow();
    for (const label of LABELS) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByText(/^FREE$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PlanBadge/)).not.toBeInTheDocument();
  });
});
