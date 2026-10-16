import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type SessionSnap = {
  data: { session: { user: { id: string }; access_token: string } | null };
};

const { getSession, onAuthStateChange } = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<SessionSnap> => ({ data: { session: null } })),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession, onAuthStateChange },
  },
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    Link: ({
      children,
      className,
    }: {
      children?: import("react").ReactNode;
      className?: string;
    }) => <a className={className}>{children}</a>,
  };
});

const fetchArtistCatalogTracks = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock("@/lib/fetch-artist-catalog", () => ({
  fetchArtistCatalogTracks,
}));

import { ArtistSupportTokenButton } from "@/components/catalog/ArtistSupportTokenButton";
import { ArtistCatalog } from "@/routes/artists";
import { omitUnplayableAlbums } from "@/lib/artist-catalog";
import { ALBUMS } from "@/lib/radio-tracks";

afterEach(() => {
  cleanup();
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { session: null } });
  fetchArtistCatalogTracks.mockReset();
  fetchArtistCatalogTracks.mockResolvedValue([]);
  vi.unstubAllGlobals();
});

describe("artist catalog header", () => {
  it("shows one support button in the release header and none on track rows", async () => {
    const album = omitUnplayableAlbums(ALBUMS).find((item) => item.id === "voices-before-the-fall");
    expect(album).toBeTruthy();
    render(
      <ArtistCatalog
        embedded
        albumParam="voices-before-the-fall"
        onOpenAlbum={() => {}}
        onBackToAlbums={() => {}}
      />,
    );

    const heading = await screen.findByRole("heading", { name: "Sage Zimba" });
    const card = heading.parentElement?.parentElement;
    expect(card?.className).toContain("from-red-950/40");
    expect(card?.className).toContain("to-blue-950/40");
    expect(screen.getByRole("img", { name: "Sage Zimba" })).toBeInTheDocument();
    expect(screen.getByText("Afro Roots / Reggae")).toBeInTheDocument();
    expect(screen.getByText(`${album!.tracks.length} Tracks`)).toBeInTheDocument();
    expect(screen.queryByText(/industrial rock/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /support artist/i })).toHaveLength(1);

    const tokenButtons = screen.getAllByRole("button", { name: "1 Token" });
    expect(tokenButtons).toHaveLength(album!.tracks.length);
    for (const button of tokenButtons) {
      const row = button.closest("li");
      expect(row).toBeTruthy();
      expect(within(row as HTMLElement).queryByRole("button", { name: /support artist/i })).toBeNull();
      expect(within(row as HTMLElement).queryByRole("button", { name: /send to email/i })).toBeNull();
    }
    expect(screen.getByRole("button", { name: /preview africa by sage zimba/i })).toBeInTheDocument();
  });

  it("omits the genre pill and uses a singular track count when the release has neither", async () => {
    fetchArtistCatalogTracks.mockResolvedValue([
      {
        id: "only-song",
        title: "Only Song",
        artist: "No Genre Band",
        src: "https://cdn.example/only.mp3",
        cover: "https://cdn.example/only.jpg",
        album: "Only Album",
        genre: "   ",
        credits: "",
        trackNumber: 1,
      },
    ]);
    render(
      <ArtistCatalog
        embedded
        albumParam="only-album"
        onOpenAlbum={() => {}}
        onBackToAlbums={() => {}}
      />,
    );

    expect(await screen.findByRole("heading", { name: "No Genre Band" })).toBeInTheDocument();
    expect(screen.getByText("1 Track")).toBeInTheDocument();
    expect(screen.queryByText(/industrial rock/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /support artist/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "1 Token" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /send to email/i })).not.toBeInTheDocument();
  });
});

describe("ArtistSupportTokenButton", () => {
  it("posts artistId and trackId to the existing catalog support checkout", async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "token-abc" } },
    });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "stopped in test" }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ArtistSupportTokenButton variant="header" artistId="sage-zimba" trackId="vbf-africa" />);
    await userEvent.click(screen.getByRole("button", { name: /support artist/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/checkout/artist-token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ artistId: "sage-zimba", trackId: "vbf-africa" }),
      }),
    );
    expect(screen.getByText("Support Artist")).toBeInTheDocument();
    expect(screen.getByText("$1")).toBeInTheDocument();
  });
});
