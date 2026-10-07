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
  getSession.mockResolvedValue({ data: { session: { user: { id: "user-1" } } } });
  from.mockImplementation((table: string) => {
    tables.push(table);
    return {
      select: () => ({
        order: () => ({
          limit: () => Promise.resolve({ data: rows, error: null }),
        }),
      }),
    };
  });
  return tables;
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

  it("shows the empty state when the vault fetch returns no masters", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue(jsonResult({ tracks: [] }));

    render(<AudioVaultList revision={1} />);

    expect(await screen.findByText(EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByText("Loading your vault...")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/vault");
    expect(from).not.toHaveBeenCalled();
  });

  it("renders a row title from vaulted_tracks", async () => {
    const tables = mockSignedInVault([
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
});
