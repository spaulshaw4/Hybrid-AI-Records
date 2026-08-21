/**
 * Integration test: upstream turbulence must never disturb the viewport.
 *
 * Simulates a real render leg going through `resilientFetch`:
 *   attempt 1 -> HTTP 503 (upstream shedding)
 *   attempt 2 -> abort/timeout ("failed to fetch" class)
 *   attempt 3 -> 200 OK
 *
 * Every attempt pushes new state into the studio-like parent (status text,
 * reconnect counter, progress, active clip). The assertion is that the
 * `<video>` element inside `CinematicMasterPlayer` keeps the *same DOM node*
 * through all of it — no unmount/remount, no flash, no reattached ref.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CinematicMasterPlayer, type MasterClip } from "@/components/CinematicMasterPlayer";
import { resilientFetch } from "@/lib/resilient-fetch.server";
import { resetBreakers } from "@/lib/circuit-breaker.server";

const CLIPS: MasterClip[] = [
  { index: 1, title: "Block 01", seconds: 8, url: "blob:clip-1" },
  { index: 2, title: "Block 02", seconds: 8, url: "blob:clip-2" },
];

function timeoutError() {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

/** Studio-shaped harness: turbulent upstream leg + stable viewport child. */
function StudioHarness({ onVideoNode }: { onVideoNode: (node: HTMLVideoElement | null) => void }) {
  const [status, setStatus] = useState("connecting");
  const [reconnects, setReconnects] = useState(0);
  const [percent, setPercent] = useState(0);
  const [blockIndex, setBlockIndex] = useState(0);
  // Background execution tracking lives in a ref so retries never re-mount.
  const startedRef = useRef(false);

  // Stable props: the clip list identity must not churn between renders.
  const clips = useMemo(() => CLIPS, []);

  const runLeg = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("rendering");
    try {
      await resilientFetch(
        "https://upstream.test/dispatch",
        { method: "POST" },
        { label: "motion dispatch", breakerKey: "test-motion", retries: 2, baseDelayMs: 1, timeoutMs: 50 },
      );
      setStatus("completed");
      setPercent(100);
      setBlockIndex(1);
    } catch {
      setStatus("failed");
    }
  }, []);

  useEffect(() => {
    void runLeg();
  }, [runLeg]);

  // Each attempt reported by the fetch mock bumps visible state.
  useEffect(() => {
    const onAttempt = (event: Event) => {
      const attempt = (event as CustomEvent<number>).detail;
      setReconnects(attempt - 1);
      setPercent((p) => Math.min(90, p + 20));
    };
    window.addEventListener("upstream-attempt", onAttempt);
    return () => window.removeEventListener("upstream-attempt", onAttempt);
  }, []);

  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="reconnects">{reconnects}</p>
      <p data-testid="percent">{percent}</p>
      <div ref={() => onVideoNode(document.querySelector("video"))} />
      <CinematicMasterPlayer clips={clips} audioUrl="blob:master-audio" key="viewport-host" />
      <p data-testid="block">{blockIndex}</p>
    </div>
  );
}

describe("viewport stability under resilientFetch reconnection", () => {
  let attempts = 0;

  beforeEach(() => {
    attempts = 0;
    resetBreakers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts += 1;
        window.dispatchEvent(new CustomEvent("upstream-attempt", { detail: attempts }));
        if (attempts === 1) return new Response("busy", { status: 503 });
        if (attempts === 2) throw timeoutError();
        return new Response(JSON.stringify({ id: "job_1" }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries through a 503 and a timeout without remounting the video element", async () => {
    const seen: (HTMLVideoElement | null)[] = [];
    render(<StudioHarness onVideoNode={(n) => seen.push(n)} />);

    const viewport = document.querySelector("video");
    expect(viewport).toBeTruthy();

    // Watch for any removal/insertion of a <video> node while the leg runs.
    let removals = 0;
    let insertions = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach((n) => {
          if ((n as HTMLElement).tagName === "VIDEO") removals += 1;
        });
        record.addedNodes.forEach((n) => {
          if ((n as HTMLElement).tagName === "VIDEO") insertions += 1;
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("completed"), {
      timeout: 5000,
    });
    // Let any trailing effects flush before we stop watching.
    await act(async () => {
      await Promise.resolve();
    });
    observer.disconnect();

    // Three upstream attempts: 503 -> timeout -> success.
    expect(attempts).toBe(3);
    expect(screen.getByTestId("reconnects").textContent).toBe("2");

    // Same DOM node throughout: no unmount, no remount, no flash.
    expect(document.querySelector("video")).toBe(viewport);
    expect(removals).toBe(0);
    expect(insertions).toBe(0);
    expect(seen.filter(Boolean).every((node) => node === seen.find(Boolean))).toBe(true);
    expect(viewport?.isConnected).toBe(true);
  });

  it("keeps the same viewport node when the upstream is exhausted and the leg fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts += 1;
        window.dispatchEvent(new CustomEvent("upstream-attempt", { detail: attempts }));
        throw timeoutError();
      }),
    );

    render(<StudioHarness onVideoNode={() => {}} />);
    const viewport = document.querySelector("video");

    let removals = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach((n) => {
          if ((n as HTMLElement).tagName === "VIDEO") removals += 1;
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("failed"), {
      timeout: 5000,
    });
    observer.disconnect();

    expect(attempts).toBe(3);
    expect(document.querySelector("video")).toBe(viewport);
    expect(viewport?.isConnected).toBe(true);
    expect(removals).toBe(0);
  });
});
