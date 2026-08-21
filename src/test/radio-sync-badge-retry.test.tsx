import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useRef, useState } from "react";
import { SyncBadge, type ResolveState } from "@/components/radio/SyncBadge";

/**
 * Drives the badge through the same retry lifecycle the radio console uses:
 * a retry clears the error, flips `retrying` on, and the resolver either fails
 * again (error state persists, retry re-armed) or succeeds
 * (resolving -> resolved, error state gone).
 */

type Attempt = { ok: true; tracks: number } | { ok: false; message: string };

function RetryHarness({ attempts, onAttempt }: { attempts: Attempt[]; onAttempt?: (n: number) => void }) {
  const index = useRef(0);
  const [resolveState, setResolveState] = useState<ResolveState | null>({
    phase: "error",
    tracks: 0,
    message: "Network unreachable",
  });
  const [retrying, setRetrying] = useState(false);
  const [lastResolvedAt, setLastResolvedAt] = useState<number | null>(null);
  const pending = useRef<((v: void) => void) | null>(null);

  const onRetry = useCallback(() => {
    const attempt = attempts[index.current] ?? { ok: false, message: "Network unreachable" };
    index.current += 1;
    onAttempt?.(index.current);
    setRetrying(true);
    setResolveState(null);
    // Resolves when the test calls `settle()`, mirroring the async round trip.
    void new Promise<void>((resolve) => {
      pending.current = resolve;
    }).then(() => {
      setRetrying(false);
      if (attempt.ok) {
        setResolveState({ phase: "resolving", tracks: attempt.tracks });
      } else {
        setResolveState({ phase: "error", tracks: 0, message: attempt.message });
      }
    });
  }, [attempts, onAttempt]);

  return (
    <div>
      <button type="button" onClick={() => pending.current?.()}>
        settle
      </button>
      <button
        type="button"
        onClick={() => {
          setResolveState((s) => (s?.phase === "resolving" ? { phase: "resolved", tracks: s.tracks } : s));
          setLastResolvedAt(Date.now());
        }}
      >
        finish
      </button>
      <SyncBadge
        accountEmail="artist@hybridairecords.com"
        syncState="synced"
        resolveState={resolveState}
        conflictNotice={false}
        lastResolvedAt={lastResolvedAt}
        retrying={retrying}
        onRetry={onRetry}
      />
    </div>
  );
}

const settle = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "settle" }));
const finish = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "finish" }));
const retryButton = () => screen.getByRole("button", { name: /retry(ing)? timestamp sync/i });

afterEach(() => cleanup());

describe("retry failure and recovery", () => {
  it("shows the error alert with a retry affordance before any retry", () => {
    render(<RetryHarness attempts={[]} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Sync failed. Network unreachable");
    expect(alert).toHaveAccessibleName("Sync failed. Network unreachable");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(retryButton()).toBeEnabled();
  });

  it("enters the in-flight state on retry and clears the stale error message", async () => {
    const user = userEvent.setup();
    render(<RetryHarness attempts={[{ ok: true, tracks: 2 }]} />);

    await user.click(retryButton());
    // Error cleared, badge is back to a polite status while the retry runs.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAccessibleName("Mix synced.");
    expect(screen.queryByText("Network unreachable")).not.toBeInTheDocument();
  });

  it("returns to the error state with the new message when the retry fails again", async () => {
    const user = userEvent.setup();
    render(<RetryHarness attempts={[{ ok: false, message: "Timed out after 10s" }]} />);

    await user.click(retryButton());
    await settle(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Sync failed. Timed out after 10s");
    expect(alert).toHaveAccessibleName("Sync failed. Timed out after 10s");
    // Retry is re-armed rather than left disabled.
    expect(retryButton()).toBeEnabled();
    expect(retryButton()).toHaveAccessibleName("Retry timestamp sync");
  });

  it("recovers on the next retry after a failure, ending in a resolved status", async () => {
    const user = userEvent.setup();
    const attempted: number[] = [];
    render(
      <RetryHarness
        attempts={[{ ok: false, message: "Timed out after 10s" }, { ok: true, tracks: 3 }]}
        onAttempt={(n) => attempted.push(n)}
      />,
    );

    await user.click(retryButton());
    await settle(user);
    await screen.findByRole("alert");

    await user.click(retryButton());
    await settle(user);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveAccessibleName(
        "Resolving playback timestamps across your devices.",
      ),
    );
    await finish(user);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveAccessibleName(
        /Resolved\. Kept the most recent play position for 3 tracks\./,
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(attempted).toEqual([1, 2]);
  });

  it("survives three consecutive failures and still recovers on the fourth attempt", async () => {
    const user = userEvent.setup();
    const attempted: number[] = [];
    render(
      <RetryHarness
        attempts={[
          { ok: false, message: "Attempt 1 failed" },
          { ok: false, message: "Attempt 2 failed" },
          { ok: false, message: "Attempt 3 failed" },
          { ok: true, tracks: 1 },
        ]}
        onAttempt={(n) => attempted.push(n)}
      />,
    );

    for (const message of ["Attempt 1 failed", "Attempt 2 failed", "Attempt 3 failed"]) {
      await user.click(retryButton());
      await settle(user);
      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert).toHaveTextContent(`Sync failed. ${message}`));
    }

    await user.click(retryButton());
    await settle(user);
    await finish(user);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveAccessibleName(
        /Resolved\. Kept the most recent play position for 1 track\./,
      ),
    );
    expect(attempted).toEqual([1, 2, 3, 4]);
  });

  it("ignores duplicate clicks while a retry is in flight", async () => {
    const user = userEvent.setup();
    const attempted: number[] = [];
    let resolvePending: (() => void) | null = null;
    function Slow() {
      const [retrying, setRetrying] = useState(false);
      const [state, setState] = useState<ResolveState | null>({
        phase: "error",
        tracks: 0,
        message: "Network unreachable",
      });
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              resolvePending = () => {
                setRetrying(false);
                setState({ phase: "error", tracks: 0, message: "Still unreachable" });
              };
            }}
          >
            arm
          </button>
          <SyncBadge
            accountEmail="a@b.com"
            syncState="synced"
            resolveState={state}
            conflictNotice={false}
            lastResolvedAt={null}
            retrying={retrying}
            onRetry={() => {
              attempted.push(attempted.length + 1);
              setRetrying(true);
            }}
          />
        </div>
      );
    }
    render(<Slow />);

    await user.click(retryButton());
    const inFlight = retryButton();
    expect(inFlight).toHaveAttribute("aria-disabled", "true");
    expect(inFlight).toHaveAccessibleName("Retrying timestamp sync");
    await user.click(inFlight);
    await user.click(inFlight);
    expect(attempted).toEqual([1]);
    expect(resolvePending).toBeNull();
  });

  it("keeps the retry button focused across a failed retry so keyboard users stay put", async () => {
    const user = userEvent.setup();
    // No helper buttons here: any extra click would move focus and mask the check.
    function AutoFail() {
      const [retrying, setRetrying] = useState(false);
      const [state, setState] = useState<ResolveState | null>({
        phase: "error",
        tracks: 0,
        message: "Network unreachable",
      });
      return (
        <SyncBadge
          accountEmail="a@b.com"
          syncState="synced"
          resolveState={state}
          conflictNotice={false}
          lastResolvedAt={null}
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            setState(null);
            setTimeout(() => {
              setRetrying(false);
              setState({ phase: "error", tracks: 0, message: "Timed out after 10s" });
            }, 20);
          }}
        />
      );
    }
    render(<AutoFail />);

    retryButton().focus();
    await user.keyboard("{Enter}");
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("Timed out after 10s"));

    expect(retryButton()).toBeEnabled();
    expect(retryButton()).toHaveFocus();
  });



  it("reports the failure through the assertive live region on every failed attempt", async () => {
    const user = userEvent.setup();
    render(
      <RetryHarness
        attempts={[
          { ok: false, message: "Attempt 1 failed" },
          { ok: false, message: "Attempt 2 failed" },
        ]}
      />,
    );

    await user.click(retryButton());
    await settle(user);
    let alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("aria-atomic", "true");

    await user.click(retryButton());
    await settle(user);
    alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("Attempt 2 failed"));
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("falls back to a generic message when the failure has no detail", async () => {
    const user = userEvent.setup();
    function NoMessage() {
      const [state, setState] = useState<ResolveState | null>(null);
      return (
        <div>
          <button type="button" onClick={() => setState({ phase: "error", tracks: 0 })}>
            fail
          </button>
          <SyncBadge
            accountEmail="a@b.com"
            syncState="synced"
            resolveState={state}
            conflictNotice={false}
            lastResolvedAt={null}
            retrying={false}
            onRetry={() => {}}
          />
        </div>
      );
    }
    render(<NoMessage />);
    await user.click(screen.getByRole("button", { name: "fail" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAccessibleName("Sync failed. Timestamp resolution failed.");
  });

  it("shows the last-aligned label only after a successful recovery", async () => {
    const user = userEvent.setup();
    render(<RetryHarness attempts={[{ ok: false, message: "Nope" }, { ok: true, tracks: 2 }]} />);

    await user.click(retryButton());
    await settle(user);
    await screen.findByRole("alert");
    expect(screen.queryByText(/ago$/)).not.toBeInTheDocument();

    await user.click(retryButton());
    await settle(user);
    await finish(user);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Devices last aligned 0s ago\./));
  });
});

describe("retry failure with fake timers", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the in-flight retry state for the whole request window", async () => {
    vi.useFakeTimers();
    function Delayed() {
      const [retrying, setRetrying] = useState(false);
      const [state, setState] = useState<ResolveState | null>({
        phase: "error",
        tracks: 0,
        message: "Network unreachable",
      });
      return (
        <SyncBadge
          accountEmail="a@b.com"
          syncState="synced"
          resolveState={state}
          conflictNotice={false}
          lastResolvedAt={null}
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            setState(null);
            setTimeout(() => {
              setRetrying(false);
              setState({ phase: "error", tracks: 0, message: "Timed out after 10s" });
            }, 10_000);
          }}
        />
      );
    }
    render(<Delayed />);

    act(() => {
      retryButton().click();
    });
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    // Still in flight: no error alert has come back yet.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Sync failed. Timed out after 10s");
    expect(retryButton()).toBeEnabled();
  });
});
