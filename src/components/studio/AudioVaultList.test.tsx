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

    await user.click(screen.getByRole("button", { name: "Track actions" }));
    expect(screen.getByRole("menuitem", { name: "Use as Reference Track" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Track Injection (Swap)" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download Master" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Track actions" }));
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
    const onUseAsReference = vi.fn();
    const onTrackInjection = vi.fn();
    mockSignedInVault([
      {
        id: "vault-42",
        title: "Glass Harbor",
        mp3_url: mp3,
        wav_url: wav,
      },
    ]);

    const { container } = render(
      <AudioVaultList revision={6} onUseAsReference={onUseAsReference} onTrackInjection={onTrackInjection} />,
    );
    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();

    const audio = container.querySelector("audio");
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("controlsList", "nodownload noplaybackrate");
    expect(audio?.className).toContain("w-full");
    expect(audio?.className).toContain("h-8");
    expect(audio).toHaveAttribute("src", mp3);

    await user.click(screen.getByRole("button", { name: "Track actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Use as Reference Track" }));
    expect(onUseAsReference).toHaveBeenCalledWith({ url: mp3, title: "Glass Harbor" });

    await user.click(screen.getByRole("button", { name: "Track actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Track Injection (Swap)" }));
    expect(onTrackInjection).toHaveBeenCalledWith({ url: mp3, title: "Glass Harbor" });
  });

  it("uses the https audio-vault wav when the mp3 is not an audio-vault url", async () => {
    const user = userEvent.setup();
    const wav = "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/glass.wav";
    const onUseAsReference = vi.fn();
    mockSignedInVault([
      {
        id: "vault-42",
        title: "Glass Harbor",
        mp3_url: "http://project.supabase.co/storage/v1/object/public/audio-vault/masters/glass.mp3",
        wav_url: wav,
      },
    ]);

    const { container } = render(<AudioVaultList revision={7} onUseAsReference={onUseAsReference} />);
    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();
    expect(container.querySelector("audio")).toHaveAttribute("src", wav);

    await user.click(screen.getByRole("button", { name: "Track actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Use as Reference Track" }));
    expect(onUseAsReference).toHaveBeenCalledWith({ url: wav, title: "Glass Harbor" });
    expect(onUseAsReference.mock.calls[0]?.[0].url).not.toMatch(/^http:/);
    expect(onUseAsReference.mock.calls[0]?.[0].url).not.toMatch(/^blob:/);
  });
});
