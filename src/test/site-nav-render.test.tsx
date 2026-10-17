import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navState = vi.hoisted(() => ({
  pathname: "/",
  search: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
    ...props
  }: {
    children?: React.ReactNode;
    to?: string;
    search?: Record<string, string>;
  }) => {
    const query =
      search && typeof search === "object" ? `?${new URLSearchParams(search).toString()}` : "";
    return (
      <a href={`${to ?? "/"}${query}`} {...props}>
        {children}
      </a>
    );
  },
  useNavigate: () => vi.fn(),
  useRouterState: (opts?: { select?: (state: unknown) => unknown }) => {
    const state = { location: navState };
    return opts?.select ? opts.select(state) : state;
  },
}));

import { MobileNav } from "@/components/SiteNav";

const LABELS = [
  "Create Your Track",
  "Catalog & Merch",
  "Plans & Tokens",
  "Hybrid AI Radio",
  "Distribution & Video Packages",
];

const HREFS = [
  "/portal?tab=create",
  "/portal?tab=catalog",
  "/portal?tab=plans",
  "/portal?tab=radio",
  "/portal?tab=distribution",
];

describe("SiteNav render", () => {
  afterEach(() => {
    navState.pathname = "/";
    navState.search = {};
    cleanup();
  });

  it("renders the five portal labels without a missing SITE_NAV reference", () => {
    expect(() => render(<MobileNav />)).not.toThrow();
    expect(screen.getByRole("navigation", { name: "Main Navigation" })).toBeInTheDocument();
    LABELS.forEach((label, index) => {
      const link = screen.getByRole("link", { name: label });
      expect(link).toHaveAttribute("href", HREFS[index]);
      expect(link.querySelector("svg")).toBeTruthy();
      expect(link.className).toContain("focus-visible:ring-2");
      expect(link.className).toContain("focus-visible:ring-red-500");
      expect(link.className).toContain("rounded-full");
    });
    expect(screen.queryByText(/^FREE$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PlanBadge/)).not.toBeInTheDocument();
  });

  it("lights Catalog for catalog_merch and Distribution for the video alias", () => {
    navState.pathname = "/portal";
    navState.search = { tab: "catalog_merch" };
    const { rerender } = render(<MobileNav />);
    const catalog = screen.getByRole("link", { name: "Catalog & Merch" });
    expect(catalog).toHaveAttribute("aria-current", "page");
    expect(catalog.className).toContain("bg-red-950/30");
    expect(screen.getByRole("link", { name: "Create Your Track" })).not.toHaveAttribute("aria-current", "page");

    navState.search = { tab: "video" };
    rerender(<MobileNav />);
    const distribution = screen.getByRole("link", { name: "Distribution & Video Packages" });
    expect(distribution).toHaveAttribute("aria-current", "page");
    expect(distribution.className).toContain("bg-red-950/30");
    expect(screen.getByRole("link", { name: "Catalog & Merch" })).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Plans & Tokens" }).className).toContain("text-zinc-400");
  });
});
