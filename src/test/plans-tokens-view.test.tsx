import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({
    data: {
      session: {
        user: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
        access_token: "session-token",
      },
    },
  })),
);

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession } },
}));

import { PlansTokensView } from "@/components/portal/PlansTokensView";

function article(name: string): HTMLElement {
  const node = screen.getByRole("heading", { name }).closest("article");
  if (!node) throw new Error(`No article for ${name}`);
  return node;
}

function expectGlass(node: HTMLElement) {
  expect(node.className).toContain("bg-zinc-900/30");
  expect(node.className).toContain("backdrop-blur-xl");
  expect(node.className).toContain("border-white/10");
  expect(node.className).toContain("shadow-[0_8px_32px_0_rgba(0,0,0,0.37)]");
  expect(node.className).not.toContain("bg-zinc-950");
  expect(node.className).not.toContain("bg-black");
  expect(node.className).not.toContain("bg-[#0d0d0d]");
}

describe("PlansTokensView individual tokens", () => {
  beforeEach(() => {
    getSession.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "stopped in test" }), { status: 400 })),
    );
  });

  it("uses glass on plans, packs, and red standalone cards", () => {
    const { container } = render(<PlansTokensView />);

    for (const name of ["Starter Producer", "Pro Producer", "Label & Studio", "5 Token Pack", "10 Token Pack", "25 Token Pack"]) {
      expectGlass(article(name));
    }

    expect(article("Starter Producer")).toHaveTextContent("10 Hybrid Tokens (Studio Runs)");
    expect(article("Starter Producer")).toHaveTextContent("10 D-Tokens (Too Lost Stores)");
    expect(article("Pro Producer")).toHaveTextContent("15 Hybrid Tokens (Studio Runs)");
    expect(article("Pro Producer")).toHaveTextContent("15 D-Tokens (Too Lost Stores)");
    expect(article("Label & Studio")).toHaveTextContent("20 Hybrid Tokens (Studio Runs)");
    expect(article("Label & Studio")).toHaveTextContent("20 D-Tokens (Too Lost Stores)");
    expect(screen.getByRole("button", { name: "$10.00" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "$20.00" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "$50.00" })).toBeInTheDocument();

    const studio = article("Engine 2.0 (Studio Run)");
    const distribution = article("Too Lost DSP Distribution");
    const support = article("Artist Tokens");
    for (const card of [studio, distribution, support]) {
      expectGlass(card);
      expect(card.className).toContain("hover:border-red-500/30");
      expect(card.className).not.toContain("hover:border-white/20");
      expect(card.querySelector(".h-0\\.5.bg-red-600")).not.toBeNull();
    }

    expect(studio).toHaveTextContent("$2.00");
    expect(studio).toHaveTextContent("/ Hybrid");
    expect(studio).not.toHaveTextContent("/ Hybrid Token");
    expect(studio).toHaveTextContent("1 studio generation run for master track rendering.");
    expect(distribution).toHaveTextContent("$1.00");
    expect(distribution).toHaveTextContent("/ D-Token");
    expect(distribution).toHaveTextContent(
      "1 standalone track release pass to global DSPs (Spotify, Apple Music) via Too Lost infrastructure.",
    );
    expect(support).toHaveTextContent("$1.00");
    expect(support).toHaveTextContent("/ token");
    expect(support).toHaveTextContent(
      "Direct artist patronage. 1 Token unlocks an uncompressed 24-bit broadcast master download and sends $1.00 directly to support the creator.",
    );
    expect(support.innerHTML).not.toMatch(/blue-|indigo-/);
    expect(screen.queryByRole("heading", { name: /Direct Support/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Support Artist/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buy Single Hybrid Token" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buy Single D-Token" })).not.toBeInTheDocument();

    expect(within(studio).getByText("1 Runs")).toHaveClass(
      "flex-1",
      "text-center",
      "font-mono",
      "text-sm",
      "font-bold",
      "text-white",
    );
    expect(within(distribution).getByText("1 Passes")).toHaveClass("flex-1", "text-center");
    expect(within(support).getByText("1 Tokens")).toHaveClass("flex-1", "text-center");

    for (const label of ["1", "3", "5", "10"]) {
      const preset = within(studio).getByRole("button", { name: label });
      expect(preset).toBeInTheDocument();
      if (label === "1") {
        expect(preset).toHaveAttribute("aria-pressed", "true");
        expect(preset.className).toContain("bg-red-600");
        expect(preset.className).toContain("text-white");
        expect(preset.className).toContain("border-red-500");
        expect(preset.className).toContain("shadow-[0_0_10px_rgba(239,68,68,0.5)]");
      }
    }
    expect(within(studio).queryByRole("button", { name: /^\$/ })).not.toBeInTheDocument();
    for (const label of ["1", "5", "10", "20"]) {
      expect(within(distribution).getByRole("button", { name: label })).toBeInTheDocument();
    }
    for (const label of [/^\$1$/, /^\$5$/, /^\$10$/, /^\$20$/]) {
      expect(within(support).getByRole("button", { name: label })).toBeInTheDocument();
    }

    expect(screen.getByRole("button", { name: "Buy Engine Runs • $2.00" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy D-Tokens • $1.00" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Artist Tokens • $1.00" })).toBeInTheDocument();

    const redOrb = container.querySelector(".blur-\\[120px\\]");
    const blueOrb = container.querySelector(".blur-\\[140px\\]");
    expect(redOrb?.className).toContain("absolute");
    expect(redOrb?.className).toContain("top-1/3");
    expect(redOrb?.className).toContain("left-10");
    expect(redOrb?.className).toContain("bg-red-600/20");
    expect(redOrb?.className).toContain("pointer-events-none");
    expect(redOrb?.className).not.toContain("-z-10");
    expect(blueOrb?.className).toContain("top-1/2");
    expect(blueOrb?.className).toContain("right-10");
    expect(blueOrb?.className).toContain("bg-blue-600/15");
    expect(blueOrb?.className).toContain("pointer-events-none");
    expect(blueOrb?.className).not.toContain("-z-10");
  });

  it("updates the three button totals from steppers and presets", async () => {
    const user = userEvent.setup();
    render(<PlansTokensView />);

    const engine = within(article("Engine 2.0 (Studio Run)"));
    const distribution = within(article("Too Lost DSP Distribution"));
    const artist = within(article("Artist Tokens"));

    expect(engine.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();
    expect(distribution.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();
    expect(artist.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();

    await user.click(engine.getByRole("button", { name: "3" }));
    expect(engine.getByText("3 Runs")).toHaveClass("text-center");
    expect(engine.getByRole("button", { name: "Buy Engine Runs • $6.00" })).toBeInTheDocument();

    await user.click(engine.getByRole("button", { name: "Increase quantity" }));
    expect(engine.getByText("4 Runs")).toBeInTheDocument();
    expect(engine.getByRole("button", { name: "Buy Engine Runs • $8.00" })).toBeInTheDocument();

    await user.click(distribution.getByRole("button", { name: "10" }));
    expect(distribution.getByText("10 Passes")).toHaveClass("text-center");
    expect(distribution.getByRole("button", { name: "Buy D-Tokens • $10.00" })).toBeInTheDocument();

    await user.click(artist.getByRole("button", { name: "$20" }));
    expect(artist.getByText("20 Tokens")).toHaveClass("text-center");
    expect(artist.getByRole("button", { name: "Artist Tokens • $20.00" })).toBeInTheDocument();

    await user.click(artist.getByRole("button", { name: "Increase quantity" }));
    expect(artist.getByRole("button", { name: "Artist Tokens • $21.00" })).toBeInTheDocument();
  });

  it("checks out engine runs, D-Tokens, and artist tokens by quantity", async () => {
    const user = userEvent.setup();
    render(<PlansTokensView />);

    const engine = within(article("Engine 2.0 (Studio Run)"));
    const distribution = within(article("Too Lost DSP Distribution"));
    const artist = within(article("Artist Tokens"));

    await user.click(engine.getByRole("button", { name: "5" }));
    await user.click(engine.getByRole("button", { name: "Buy Engine Runs • $10.00" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await user.click(distribution.getByRole("button", { name: "20" }));
    await user.click(distribution.getByRole("button", { name: "Buy D-Tokens • $20.00" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    await user.click(artist.getByRole("button", { name: "$10" }));
    await user.click(artist.getByRole("button", { name: "Increase quantity" }));
    await user.click(artist.getByRole("button", { name: "Artist Tokens • $11.00" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(([url, init]) => {
      const headers = new Headers(init?.headers);
      return {
        url,
        method: init?.method,
        authorization: headers.get("Authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
    })).toEqual([
      {
        url: "/api/billing/checkout",
        method: "POST",
        authorization: "Bearer session-token",
        body: { tokenType: "h_token", quantity: 5 },
      },
      {
        url: "/api/billing/checkout",
        method: "POST",
        authorization: "Bearer session-token",
        body: { tokenType: "d_token", quantity: 20 },
      },
      {
        url: "/api/billing/checkout",
        method: "POST",
        authorization: "Bearer session-token",
        body: { tokenType: "artist_token", quantity: 11 },
      },
    ]);
    for (const [, init] of calls) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("priceId");
      expect(body).not.toHaveProperty("userId");
    }
  });
});
