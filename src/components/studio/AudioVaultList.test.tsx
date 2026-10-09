import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function installMenuPolyfills() {
  const proto = HTMLElement.prototype;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => undefined;
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => undefined;
  if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;
}

const { getSession, from } = vi.hoisted(() => ({
  getSession: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession },
    from,
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example/${path}` } }),
      }),
    },
  },
}));

import { AudioVaultList } from "./AudioVaultList";

const EMPTY_COPY = "No ready masters yet. Create a track and it will show up here.";
const LOCKED_COPY = "Sign in to access your private Audio Vault and release-ready masters.";
const VAULT_COLUMNS = "id, title, prompt, wav_url, mp3_url, created_at, user_id";

function jsonResult(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockSignedInVault(rows: Array<Record<string, unknown>>) {
  const tables: string[] = [];
  const filters: Array<[string, string]> = [];
  const selected: string[] = [];
  const orders: Array<[string, boolean]> = [];
  getSession.mockResolvedValue({
    data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
  });
  from.mockImplementation((table: string) => {
    tables.push(table);
    return {
      select: (columns: string) => {
        selected.push(columns);
        return {
          eq: (column: string, value: string) => {
            filters.push([column, value]);
            return {
              order: (columnName: string, options: { ascending: boolean }) => {
                orders.push([columnName, options.ascending]);
                return {
                  limit: () => Promise.resolve({ data: rows, error: null }),
                };
              },
            };
          },
        };
      },
    };
  });
  return { tables, filters, selected, orders };
}

describe("AudioVaultList", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    cleanup();
    installMenuPolyfills();
    getSession.mockReset();
    from.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("locks the vault for a signed-out visitor and does not load tracks", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue(
      jsonResult({
        tracks: [
          { id: "leak-1", title: "Feel It in the Rain" },
          { id: "leak-2", title: "Go Crazy" },
        ],
      }),
    );

    render(
      <AudioVaultList
        revision={1}
        pending={[
          { id: "pending-1", title: "Feel It in the Rain", status: "Rendering" },
          { id: "pending-2", title: "Go Crazy", status: "Failed" },
        ]}
      />,
    );

    expect(await screen.findByText(LOCKED_COPY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "\u2212 Minimize Vault" })).toBeInTheDocument();
    expect(screen.queryByText("0 Masters")).not.toBeInTheDocument();
    expect(screen.queryByText("1 Master")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading your vault...")).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
    expect(screen.queryByText("Feel It in the Rain")).not.toBeInTheDocument();
    expect(screen.queryByText("Go Crazy")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("renders a row title from vaulted_tracks", async () => {
    const { tables, filters, selected, orders } = mockSignedInVault([
      {
        id: "vault-42",
        title: "Glass Harbor",
        prompt: "amber glass",
        mp3_url: null,
        wav_url: null,
      },
    ]);

    render(<AudioVaultList revision={2} />);

    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();
    expect(tables).toEqual(["vaulted_tracks"]);
    expect(selected).toEqual([VAULT_COLUMNS]);
    expect(filters).toEqual([["user_id", "user-1"]]);
    expect(orders).toEqual([["created_at", false]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms delete and calls DELETE /api/vault/:id", async () => {
    const user = userEvent.setup();
    mockSignedInVault([
      {
        id: "vault-42",
        title: "Glass Harbor",
        prompt: "amber glass",
        mp3_url: null,
        wav_url: null,
      },
    ]);
    fetchMock.mockResolvedValue(jsonResult({}));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AudioVaultList revision={3} />);
    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Track options" }));
    expect(screen.queryByRole("menuitem", { name: "Use as Reference Track" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Track Injection (Swap)" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download MP3" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download WAV" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete from Vault" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Delete from Vault" }));

    expect(confirmSpy).toHaveBeenCalledWith("Permanently delete this master from the vault?");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/vault/vault-42", {
        method: "DELETE",
        headers: { Authorization: "Bearer session-token" },
      });
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(["/api/vault/vault-42"]);
    await waitFor(() => {
      expect(screen.queryByText("Glass Harbor")).not.toBeInTheDocument();
    });
  });

  it("keeps the row when delete is not confirmed", async () => {
    const user = userEvent.setup();
    mockSignedInVault([
      {
        id: "vault-42",
        title: "Glass Harbor",
        mp3_url: null,
        wav_url: null,
      },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AudioVaultList revision={4} />);
    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Track options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete from Vault" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Glass Harbor")).toBeInTheDocument();
  });

  it("loads the service-role catalog when the signed-in query is empty", async () => {
    mockSignedInVault([]);
    fetchMock.mockResolvedValue(
      jsonResult({
        tracks: [
          {
            id: "vault-9",
            title: "Like the wind",
            genre: "open air",
            wav_url: "https://cdn.example/a.wav",
            mp3_url: "https://cdn.example/a.mp3",
          },
        ],
      }),
    );

    render(<AudioVaultList revision={5} />);

    expect(await screen.findByText("Like the wind")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/vault", {
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("hides the native audio menu and prefers an https audio-vault mp3", async () => {
    const user = userEvent.setup();
    const mp3 = "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/glass.mp3";
    const wav = "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/glass.wav";
    mockSignedInVault([
      {
        id: "vault-42",
        title: "Glass Harbor",
        mp3_url: mp3,
        wav_url: wav,
      },
    ]);

    const { container } = render(<AudioVaultList revision={6} />);
    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();

    const audio = container.querySelector("audio");
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("controlsList", "nodownload noplaybackrate");
    expect(audio?.className).toContain("w-full");
    expect(audio?.className).toContain("h-8");
    expect(audio).toHaveAttribute("src", mp3);

    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = realCreate(tagName);
      if (tagName.toLowerCase() === "a") {
        element.click = () => undefined;
        anchors.push(element as HTMLAnchorElement);
      }
      return element;
    });

    await user.click(screen.getByRole("button", { name: "Track options" }));
    expect(screen.queryByRole("menuitem", { name: "Use as Reference Track" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Track Injection (Swap)" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Download MP3" }));
    expect(anchors[0]?.getAttribute("href")).toContain("download=");
    expect(anchors[0]?.getAttribute("href")).toContain(encodeURIComponent("Glass_Harbor.mp3"));
    expect(anchors[0]?.getAttribute("href")).toContain(mp3);
  });

  it("uses the https audio-vault wav when the mp3 is not an https url", async () => {
    const user = userEvent.setup();
    const wav = "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/glass.wav";
    mockSignedInVault([
      {
        id: "vault-42",
        title: "Glass Harbor",
        mp3_url: "http://project.supabase.co/storage/v1/object/public/audio-vault/masters/glass.mp3",
        wav_url: wav,
      },
    ]);

    const { container } = render(<AudioVaultList revision={7} />);
    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();
    expect(container.querySelector("audio")).toHaveAttribute("src", wav);

    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = realCreate(tagName);
      if (tagName.toLowerCase() === "a") {
        element.click = () => undefined;
        anchors.push(element as HTMLAnchorElement);
      }
      return element;
    });

    await user.click(screen.getByRole("button", { name: "Track options" }));
    await user.click(screen.getByRole("menuitem", { name: "Download MP3" }));
    expect(anchors[0]?.getAttribute("href")).toBe(`${wav}?download=${encodeURIComponent("Glass_Harbor.mp3")}`);
    expect(anchors[0]?.getAttribute("href")).not.toMatch(/^http:/);
  });

  it("alerts instead of downloading a fake wav when mp3 and wav urls match", async () => {
    const user = userEvent.setup();
    const same = "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/glass.mp3";
    mockSignedInVault([
      {
        id: "vault-42",
        title: "Glass Harbor",
        mp3_url: same,
        wav_url: same,
      },
    ]);
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = realCreate(tagName);
      if (tagName.toLowerCase() === "a") {
        element.click = () => undefined;
        anchors.push(element as HTMLAnchorElement);
      }
      return element;
    });

    render(<AudioVaultList revision={8} />);
    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Track options" }));
    await user.click(screen.getByRole("menuitem", { name: "Download WAV" }));

    expect(alertSpy).toHaveBeenCalledWith("WAV master is currently processing or unavailable for this take.");
    expect(anchors).toHaveLength(0);
  });

  it("hides the track list when minimized and shows it again when expanded", async () => {
    const user = userEvent.setup();
    mockSignedInVault([
      {
        id: "vault-42",
        title: "Glass Harbor",
        mp3_url: null,
        wav_url: null,
      },
    ]);

    const { container } = render(<AudioVaultList revision={9} />);
    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();
    expect(screen.getByText("1 Master")).toBeInTheDocument();
    const scroller = container.querySelector(".max-h-\\[380px\\]");
    expect(scroller?.className).toContain("overflow-y-auto");
    expect(scroller).toHaveTextContent("Glass Harbor");

    await user.click(screen.getByRole("button", { name: "\u2212 Minimize Vault" }));
    expect(screen.queryByText("Glass Harbor")).not.toBeInTheDocument();
    expect(container.querySelector(".max-h-\\[380px\\]")).toBeNull();
    expect(screen.getByRole("button", { name: "+ Expand Vault" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ Expand Vault" }));
    expect(screen.getByText("Glass Harbor")).toBeInTheDocument();
    expect(container.querySelector(".max-h-\\[380px\\]")?.className).toContain("overflow-y-auto");
  });
});
