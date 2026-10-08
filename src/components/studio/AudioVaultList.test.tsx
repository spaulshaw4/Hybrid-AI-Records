import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

    await user.click(screen.getByRole("button", { name: "Actions for Glass Harbor" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(confirmSpy).toHaveBeenCalledWith("Permanently delete this master from the vault?");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/vault/vault-42", { method: "DELETE" });
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

    await user.click(screen.getByRole("button", { name: "Actions for Glass Harbor" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

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
});
