import { render, screen } from "@testing-library/react";
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

describe("PlansTokensView individual tokens", () => {
  beforeEach(() => {
    getSession.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "stopped in test" }), { status: 400 })),
    );
  });

  it("shows glass studio, Too Lost, and $1 artist-support cards", () => {
    render(<PlansTokensView />);

    const studio = screen.getByRole("heading", { name: "Engine 2.0 (Studio Run)" }).closest("article");
    const distribution = screen.getByRole("heading", { name: "Too Lost DSP Distribution" }).closest("article");
    const support = screen.getByRole("heading", { name: "Artist Tokens (Direct Support)" }).closest("article");
    expect(studio).toHaveTextContent("$2.00");
    expect(studio).toHaveTextContent("/ Hybrid Token");
    expect(distribution).toHaveTextContent("$1.00");
    expect(distribution).toHaveTextContent("/ D-Token");
    expect(support).toHaveTextContent("$1.00");
    expect(support).toHaveTextContent("/ token");
    expect(
      screen.getByText(
        "Direct artist patronage. 1 Token unlocks an uncompressed 24-bit broadcast master download and sends $1.00 directly to support the creator.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Track Unlocks/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buy Hybrid Tokens" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy Single Hybrid Token" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy Single D-Token" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Support Artist • $1.00" })).toBeInTheDocument();
    for (const label of [/^\$1$/, /^\$5$/, /^\$10$/, /^\$20$/]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("updates the support total from presets and checks out artist tokens at quantity", async () => {
    const user = userEvent.setup();
    render(<PlansTokensView />);

    await user.click(screen.getByRole("button", { name: /^\$10$/ }));
    expect(screen.getByRole("button", { name: "Support Artist • $10.00" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Increase quantity" }));
    expect(screen.getByRole("button", { name: "Support Artist • $11.00" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Support Artist • $11.00" }));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe("/api/billing/checkout");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer session-token");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ tokenType: "artist_token", quantity: 11 });
    expect(body).not.toHaveProperty("priceId");
    expect(body).not.toHaveProperty("userId");
  });
});
