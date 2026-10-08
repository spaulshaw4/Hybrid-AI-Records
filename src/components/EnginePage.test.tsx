import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MUREKA_TEMPLATES } from "@/data/murekaTemplates";

const { getSession, onAuthStateChange } = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession, onAuthStateChange },
    from: vi.fn(),
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: () => ({ data: { publicUrl: "https://example.com/audio.wav" } }),
        upload: vi.fn(),
      })),
    },
  },
}));

import { EnginePage } from "./EnginePage";

function jsonResult(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("EnginePage instrumental tab", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    getSession.mockReset();
    onAuthStateChange.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockResolvedValue({ data: { session: null } });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/generate")) {
        return jsonResult({
          success: true,
          status: "ready",
          wavUrl: "https://example.com/storage/v1/object/public/audio-vault/masters/ready.wav",
        });
      }
      return jsonResult({ tracks: [] });
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders Instrumental, fills the vibe from a template, and posts isInstrumental", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);

    expect(screen.getByRole("tab", { name: "Instrumental", selected: true })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Easy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /make a beat/i })).not.toBeInTheDocument();

    const vibe = screen.getByRole("textbox", { name: "What's the vibe?" });
    expect(screen.getByRole("button", { name: "3 min", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30 sec" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 min 30 sec" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "4 min" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "6 min" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Track Length (Seconds)")).toHaveValue(180);

    const grunge = MUREKA_TEMPLATES.find((template) => template.title === "Heavy Grunge Acoustic");
    expect(grunge?.prompt).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Heavy Grunge Acoustic/ }));
    expect(vibe).toHaveValue(grunge!.prompt);

    await user.click(screen.getByRole("button", { name: "30 sec" }));
    expect(screen.getByLabelText("Track Length (Seconds)")).toHaveValue(30);

    await user.click(screen.getByRole("button", { name: "Render Master Record" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/generate"))).toBe(true));
    const generateCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/generate")) as [string, RequestInit];
    expect(generateCall[0]).toBe("/api/generate");
    const body = JSON.parse(String(generateCall[1].body)) as {
      prompt: string;
      stylePrompt: string;
      isInstrumental: boolean;
      vocal_id?: string;
      reference_id?: string;
      seed?: number;
      webhook?: string;
    };
    expect(body.prompt).toBe(grunge!.prompt);
    expect(body.stylePrompt).toBe(grunge!.prompt);
    expect(body.isInstrumental).toBe(true);
    expect(body.vocal_id).toBeUndefined();
    expect(body.reference_id).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.webhook).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/generate"))).toBe(false);
  });

  it("keeps Without Vocals locked and opens Vocal Studio on With Vocals", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);

    await user.click(screen.getByRole("tab", { name: "Without Vocals" }));
    const locked = screen.getByRole("button", { name: "+ Vocal" });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute("title", "Vocals disabled in instrumental mode");
    expect(screen.getByRole("button", { name: "6 min" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Render Master Record" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Song title" })).toHaveAttribute("placeholder", "Enter song title");

    await user.click(screen.getByRole("tab", { name: "With Vocals" }));
    const vocal = screen.getByRole("button", { name: "+ Vocal" });
    expect(vocal).toBeEnabled();
    await user.click(vocal);
    expect(screen.getByRole("heading", { name: "Vocal Studio" })).toBeInTheDocument();
    expect(screen.getByText("Select, record, or inject a vocal into your production")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Record / Input Your Voice" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Vocal Swap / Track Inject" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+ Add Vocal/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /My Voice - October 5/ })).toBeInTheDocument();
    const overlay = screen.getByRole("heading", { name: "Vocal Studio" }).closest(".fixed");
    expect(overlay?.className).toContain("bg-black/85");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Vocal Studio" })).not.toBeInTheDocument();
  });

  it("covers the screen with the templates overlay and keeps genre pills outside the card scroller", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);

    await user.click(screen.getByRole("button", { name: /View more/ }));
    const dialog = screen.getByRole("dialog", { name: "Templates" });
    expect(dialog.parentElement).toHaveClass("fixed", "inset-0", "z-50", "bg-black/90", "backdrop-blur-md");
    expect(screen.getByText(/Showing \d+ production presets/)).toBeInTheDocument();
    const genres = screen.getByRole("group", { name: "Genres" });
    expect(genres.className).toContain("mt-4");
    expect(genres.parentElement?.querySelector(".pt-6")).toBeTruthy();
    const rock = screen.getByRole("button", { name: "Rock" });
    const scroller = screen.getByLabelText("Production presets");
    expect(scroller.className).toContain("max-h-[80vh]");
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.contains(rock)).toBe(false);
    expect(screen.getByRole("button", { name: "Hip-hop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Electronic" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drill" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Templates" })).not.toBeInTheDocument();
  });
});
