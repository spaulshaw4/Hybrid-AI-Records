import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => (typeof fn === "function" ? fn : async () => []),
}));

vi.mock("@/lib/voice-library.functions", () => ({
  listVoiceProfiles: vi.fn(async () => []),
  getVoiceCloneJob: vi.fn(),
  parseVoiceProfileSaveError: vi.fn(),
  saveVoiceProfile: vi.fn(),
  startVoiceCloneJob: vi.fn(),
}));

vi.mock("@/lib/has-session", () => ({
  hasSupabaseSession: async () => false,
}));

import { QuickVocalRecorder } from "@/components/QuickVocalRecorder";
import { VOCAL_LIABILITY_SESSION_KEY } from "@/lib/vocal-consent";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];

  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  timeslice: number | undefined;

  constructor(_stream: MediaStream) {
    FakeMediaRecorder.instances.push(this);
  }

  start = vi.fn((timeslice?: number) => {
    this.timeslice = timeslice;
    this.state = "recording";
  });

  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)]) });
    this.onstop?.();
  });
}

function Harness() {
  const [tick, setTick] = useState(0);
  const [held, setHeld] = useState<File | Blob | null>(null);
  return (
    <div>
      <button type="button" onClick={() => setTick((value) => value + 1)}>
        Refresh parent {tick}
      </button>
      <p data-testid="held-bytes">{held ? String(held.size) : "0"}</p>
      <p data-testid="held-type">{held?.type ?? "none"}</p>
      <p data-testid="held-name">{held instanceof File ? held.name : "none"}</p>
      <QuickVocalRecorder
        voiceId=""
        signedIn={tick % 2 === 0}
        onVoiceIdChange={() => undefined}
        onCustomFileChange={setHeld}
        retainedFile={held}
        retainedPreviewUrl={null}
      />
    </div>
  );
}

describe("QuickVocalRecorder", () => {
  const fetchSpy = vi.fn();
  let now = 1_000_000;

  beforeEach(() => {
    cleanup();
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    sessionStorage.setItem(VOCAL_LIABILITY_SESSION_KEY, "true");
    FakeMediaRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockReset();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("records in 1000ms slices, keeps the take across a parent update, and does not call voice process", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /record vocals/i }));

    await waitFor(() => {
      expect(FakeMediaRecorder.instances).toHaveLength(1);
    });
    const recorder = FakeMediaRecorder.instances[0]!;
    expect(recorder.start).toHaveBeenCalledWith(1000);
    expect(typeof recorder.onerror).toBe("function");
    expect(recorder.state).toBe("recording");

    fireEvent.click(screen.getByRole("button", { name: /refresh parent/i }));
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(recorder.state).toBe("recording");

    now += 6_000;
    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));

    const player = await screen.findByLabelText("Recorded take");
    expect(player.tagName).toBe("AUDIO");
    expect(player).toHaveAttribute("controls");
    await waitFor(() => {
      expect(screen.getByTestId("held-bytes").textContent).toBe("4096");
    });
    expect(screen.getByTestId("held-type").textContent).toBe("audio/wav");
    expect(screen.getByTestId("held-name").textContent).toBe("recording.wav");
    expect(() => {
      act(() => {
        recorder.onerror?.(new Event("error"));
      });
    }).not.toThrow();
    expect(screen.getByTestId("held-bytes").textContent).toBe("4096");

    fireEvent.click(screen.getByRole("button", { name: /refresh parent/i }));
    expect(screen.getByLabelText("Recorded take")).toBeInTheDocument();
    expect(screen.getByTestId("held-bytes").textContent).toBe("4096");
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /discard take/i }));
    await waitFor(() => {
      expect(screen.getByTestId("held-bytes").textContent).toBe("0");
    });
    expect(screen.queryByLabelText("Recorded take")).toBeNull();
  });
});
