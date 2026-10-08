import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogAlbumGrid } from "@/components/catalog/CatalogAlbumCard";
import {
  artistTrackToPlayable,
  groupPlayablesAsAlbums,
  omitUnplayableAlbums,
  type ArtistCatalogTrack,
  type CatalogPlayable,
} from "@/lib/artist-catalog";
import {
  clearCatalogStoragePresenceCache,
  omitTracksMissingFromStorage,
} from "@/lib/catalog-player";
import type { Album } from "@/lib/radio-tracks";

const playable: ArtistCatalogTrack = {
  id: "gravity-left-behind-the-gravity-well",
  album_id: "gravity-left-behind",
  album_title: "Gravity Left Behind",
  artist_name: "Stephen P. Shaw",
  title: "The Gravity Well",
  track_number: 1,
  track_total: 1,
  audio_url: "https://cdn.example/gravity.mp3",
  cover_url: "https://cdn.example/gravity.jpg",
  storage_path: "Gravity Left Behind/01-The Gravity Well.mp3",
  genre: "Space Rock",
  credits: "Written by Stephen P. Shaw",
  division: "jester",
  radio_ready: true,
  price_tokens: 1,
};

function deadRow(
  title: string,
  audio_url: string | null,
  storage_path: string | null,
): ArtistCatalogTrack {
  return {
    ...playable,
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    album_id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    album_title: title,
    artist_name: title,
    title,
    audio_url,
    storage_path,
    cover_url: null,
  };
}

afterEach(() => {
  cleanup();
});

describe("catalog album cards", () => {
  it("hides Golden Eyes and null audio, and exposes the beam on a playable card", async () => {
    const rows = [
      playable,
      deadRow("Golden Eyes 265", null, "Golden Eyes 265/golden.mp3"),
      deadRow("Dead Air", "", "Dead Air/silence.mp3"),
      deadRow("No Object", "https://cdn.example/missing.mp3", ""),
    ];
    const fromRows = omitUnplayableAlbums(
      groupPlayablesAsAlbums(
        rows
          .map(artistTrackToPlayable)
          .filter((track): track is CatalogPlayable => track !== null),
      ),
    );
    const leaked: Album = {
      id: "golden-eyes-265",
      title: "Golden Eyes 265",
      artist: "Golden Eyes 265",
      cover: "",
      credits: "",
      genre: "",
      tracks: [{ id: "golden-eyes-265", title: "Golden Eyes 265", src: "" }],
    };
    const onOpen = vi.fn();
    render(<CatalogAlbumGrid albums={[...fromRows, leaked]} onOpen={onOpen} />);

    expect(screen.queryByText(/golden eyes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/dead air/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no object/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /golden eyes/i })).not.toBeInTheDocument();

    const card = screen.getByRole("button", { name: /open album gravity left behind/i });
    expect(card).toHaveClass("relative", "group", "w-full", "cursor-pointer");
    expect(screen.getByText("Gravity Left Behind")).toBeInTheDocument();
    expect(screen.getByText("Stephen P. Shaw")).toBeInTheDocument();
    expect(screen.getByText(/1 Tracks/i)).toBeInTheDocument();

    const beam = screen.getByTestId("catalog-album-beam");
    expect(beam).toHaveClass("animate-border-beam", "opacity-40", "pointer-events-none");
    expect(card.querySelector(".opacity-0")).toBeTruthy();

    await userEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith("gravity-left-behind");
  });

  it("drops an album after its only track is marked missing", () => {
    const album = groupPlayablesAsAlbums([artistTrackToPlayable(playable)!])[0];
    const visible = omitUnplayableAlbums([album], new Set([playable.id]));
    render(<CatalogAlbumGrid albums={visible} onOpen={() => {}} />);
    expect(screen.queryByText("Gravity Left Behind")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not render a row whose audio URL is set but storage returns NoSuchKey", async () => {
    clearCatalogStoragePresenceCache();
    const missingUrl = "https://cdn.example/storage/Kilimanjaro/Kilimanjaro.wav";
    const kilimanjaro: ArtistCatalogTrack = {
      ...playable,
      id: "kilimanjaro-kilimanjaro",
      album_id: "kilimanjaro",
      album_title: "Kilimanjaro",
      artist_name: "Golden Ice 265",
      title: "Kilimanjaro",
      audio_url: missingUrl,
      storage_path: "Kilimanjaro/Kilimanjaro.wav",
      cover_url: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const missing = url.includes("Kilimanjaro");
        if ((init?.method ?? "GET") === "HEAD") {
          return new Response(null, {
            status: missing ? 400 : 200,
            headers: { "content-type": missing ? "application/json" : "audio/mpeg" },
          });
        }
        return new Response(
          JSON.stringify({
            statusCode: "404",
            error: "not_found",
            message: "Object not found",
            code: "NoSuchKey",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }),
    );

    try {
      const mapped = [kilimanjaro, playable]
        .map(artistTrackToPlayable)
        .filter((track): track is CatalogPlayable => track !== null);
      expect(mapped.map((track) => track.album)).toEqual(["Kilimanjaro", "Gravity Left Behind"]);

      const present = await omitTracksMissingFromStorage(mapped);
      const again = await omitTracksMissingFromStorage(mapped);
      render(
        <CatalogAlbumGrid
          albums={omitUnplayableAlbums(groupPlayablesAsAlbums(present))}
          onOpen={() => {}}
        />,
      );

      expect(present.map((track) => track.album)).toEqual(["Gravity Left Behind"]);
      expect(again).toEqual(present);
      expect(screen.queryByText(/kilimanjaro/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/golden ice/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /gravity left behind/i })).toBeInTheDocument();
      const heads = vi.mocked(fetch).mock.calls.filter((call) => {
        const init = call[1] as RequestInit | undefined;
        return (init?.method ?? "GET") === "HEAD";
      });
      expect(heads).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      clearCatalogStoragePresenceCache();
    }
  });
});
