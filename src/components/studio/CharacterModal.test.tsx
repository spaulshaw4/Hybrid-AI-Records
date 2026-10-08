import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CharacterModal, { type VocalCharacter, type VocalSourceSelection } from "./CharacterModal";

const SHORT_TAKE_WARNING = "Sonic requires at least 15 seconds of audio for accurate voice profiling.";
const LIVE_MIC_COPY = "Live mic capture (15–30s take).";
const USER_ID = "user-1";

const CHARACTERS: VocalCharacter[] = [
  {
    id: "char-stephen-oct5",
    name: "My Voice - October 5",
    timbreTag: "Powerful",
    isPublished: true,
    vocalId: "vocal_stephen_oct5_master",
  },
];

const { getSession, upload, getPublicUrl, from, storageFrom } = vi.hoisted(() => ({
  getSession: vi.fn(),
  upload: vi.fn(async () => ({ error: null })),
  getPublicUrl: vi.fn((path: string) => ({
    data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/audio-vault/${path}` },
  })),
  from: vi.fn(),
  storageFrom: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession },
    from,
    storage: { from: storageFrom },
  },
}));

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) {
    return type.startsWith("audio/webm");
  }

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType || "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start = vi.fn(() => {
    this.state = "recording";
  });

  stop = vi.fn(() => {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) });
    this.onstop?.();
  });
}

function StudioHarness() {
  const [source, setSource] = useState<VocalSourceSelection | null>(null);
  const [characterId, setCharacterId] = useState<string | null>(null);
  return (
    <div>
      <p data-testid="selected-vocal-url">{source?.url ?? ""}</p>
      <p data-testid="selected-persona">{characterId ?? ""}</p>
      <CharacterModal
        isOpen
        onClose={() => undefined}
        characters={CHARACTERS}
        selectedCharacterId={characterId}
        onSelectCharacter={(character) => setCharacterId(character.id)}
        selectedSourceUrl={source?.url ?? null}
        onSelectSource={setSource}
      />
    </div>
  );
}

describe("CharacterModal voice capture", () => {
  let now = 1_700_000_000_000;
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
  let revokeUrl: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cleanup();
    now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "" });
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => undefined });
    }
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-take");
    revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    FakeMediaRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ tracks: [] }),
        text: async () => "{}",
      })),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    getSession.mockReset();
    getSession.mockResolvedValue({
      data: { session: { user: { id: USER_ID }, access_token: "session-token" } },
    });
    upload.mockReset();
    upload.mockResolvedValue({ error: null });
    getPublicUrl.mockReset();
    getPublicUrl.mockImplementation((path: string) => ({
      data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/audio-vault/${path}` },
    }));
    storageFrom.mockReset();
    storageFrom.mockImplementation(() => ({ upload, getPublicUrl }));
    from.mockReset();
    from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function beginRecording() {
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    const recorder = FakeMediaRecorder.instances[0]!;
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorder.state).toBe("recording");
    return recorder;
  }

  function stopAfter(ms: number) {
    now += ms;
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  }

  it("shows the 15–30s subtext and does not start the microphone until Record", async () => {
    render(<StudioHarness />);
    expect(screen.getByText(LIVE_MIC_COPY)).toBeInTheDocument();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    await beginRecording();
  });

  it("auto-stops at 30s rather than 15s and keeps that take", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    render(<StudioHarness />);
    const recorder = await beginRecording();
    const delays = timeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toContain(30_000);
    expect(delays).not.toContain(15_000);
    now += 15_000;
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(screen.queryByText(SHORT_TAKE_WARNING)).not.toBeInTheDocument();
    expect(screen.queryByText(/Voice Captured/)).not.toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();

    now += 15_000;
    const limit = timeoutSpy.mock.calls.find((call) => call[1] === 30_000);
    expect(limit).toBeTruthy();
    act(() => {
      (limit![0] as () => void)();
    });

    expect(await screen.findByText("✓ Voice Captured 30s")).toBeInTheDocument();
    expect(screen.queryByText(SHORT_TAKE_WARNING)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Captured vocal").tagName).toBe("AUDIO");
    expect(screen.getByRole("button", { name: "Re-record" })).toBeInTheDocument();
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [path, file, options] = upload.mock.calls[0] as [string, File, { contentType?: string }];
    expect(path).toMatch(new RegExp(`^vocal-references/${USER_ID}/voice-take-\\d+\\.wav$`));
    expect(file.type).toBe("audio/wav");
    expect(options).toMatchObject({ contentType: "audio/wav" });
    expect(storageFrom).toHaveBeenCalledWith("audio-vault");
    await waitFor(() =>
      expect(screen.getByTestId("selected-vocal-url").textContent).toBe(
        `https://project.supabase.co/storage/v1/object/public/audio-vault/${path}`,
      ),
    );
    expect(screen.getByTestId("selected-persona")).toHaveTextContent("");
  });

  it("caps the recording timer at 30s", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    render(<StudioHarness />);
    await beginRecording();
    now += 45_000;
    const tick = intervalSpy.mock.calls.find((call) => call[1] === 200);
    expect(tick).toBeTruthy();
    act(() => {
      (tick![0] as () => void)();
    });
    expect(screen.getByRole("button", { name: "Stop recording" })).toHaveTextContent("Stop 30s");
  });

  it("rejects a stop before 15s without uploading or selecting the take", async () => {
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(14_999);
    const warning = screen.getByText(SHORT_TAKE_WARNING);
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent(/^Sonic requires at least 15 seconds of audio for accurate voice profiling\.$/);
    expect(screen.queryByText(/Voice Captured/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Captured vocal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /My Voice - October 5/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.getByTestId("selected-persona")).toHaveTextContent("");
    await act(async () => {
      await Promise.resolve();
    });
    expect(upload).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("accepts a stop at 15 seconds", async () => {
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(15_000);
    expect(await screen.findByText("✓ Voice Captured 15s")).toBeInTheDocument();
    expect(screen.queryByText(SHORT_TAKE_WARNING)).not.toBeInTheDocument();
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });

  it("renders the captured card and uploads a 21s take to the user folder", async () => {
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(21_000);
    const stampedAt = now;
    const badge = await screen.findByText("✓ Voice Captured 21s");
    const card = screen.getByLabelText("Captured Vocal");
    expect(screen.getByRole("heading", { name: "Record / Input Your Voice" }).closest("section")).toContainElement(card);
    expect(card).toContainElement(badge);
    const audio = screen.getByLabelText("Captured vocal");
    expect(audio.tagName).toBe("AUDIO");
    expect((audio as HTMLAudioElement).controls).toBe(true);
    expect(audio).toHaveAttribute("src", "blob:voice-take");
    expect(screen.getByRole("button", { name: "Re-record" })).toBeInTheDocument();

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [path, file, options] = upload.mock.calls[0] as [string, File, { contentType?: string }];
    expect(path).toBe(`vocal-references/${USER_ID}/voice-take-${stampedAt}.wav`);
    expect(file.type).toBe("audio/wav");
    expect(file.name).toBe(`voice-take-${stampedAt}.wav`);
    expect(options).toMatchObject({ contentType: "audio/wav", upsert: false });
    const publicUrl = `https://project.supabase.co/storage/v1/object/public/audio-vault/${path}`;
    await waitFor(() => expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent(publicUrl));
    expect(screen.getByTestId("selected-persona")).toHaveTextContent("");
    expect(screen.getByRole("button", { name: /My Voice - October 5/ })).toHaveAttribute("aria-pressed", "false");
    expect(publicUrl.startsWith("https://")).toBe(true);
    expect(publicUrl).toContain("/audio-vault/");
    expect(publicUrl).not.toMatch(/^blob:/);
  });

  it("keeps the local preview when upload fails or the public URL is not an audio-vault https URL", async () => {
    upload.mockResolvedValueOnce({ error: { message: "row-level security" } });
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(21_000);
    expect(await screen.findByText("✓ Voice Captured 21s")).toBeInTheDocument();
    expect(await screen.findByText("Upload failed.")).toBeInTheDocument();
    expect(screen.getByLabelText("Captured vocal")).toHaveAttribute("src", "blob:voice-take");
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.queryByText(/row-level security/)).not.toBeInTheDocument();
  });

  it.each([
    "http://project.supabase.co/storage/v1/object/public/audio-vault/vocal-references/user-1/take.wav",
    "blob:http://127.0.0.1/take",
    "https://cdn.example/vocal.wav",
  ])("does not select %s", async (publicUrl) => {
    getPublicUrl.mockReturnValue({ data: { publicUrl } });
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(18_000);
    expect(await screen.findByText("✓ Voice Captured 18s")).toBeInTheDocument();
    expect(await screen.findByText("Upload failed.")).toBeInTheDocument();
    expect(screen.getByLabelText("Captured vocal")).toHaveAttribute("src", "blob:voice-take");
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
  });

  it("previews a valid take when signed out and does not upload it", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(16_000);
    expect(await screen.findByText("✓ Voice Captured 16s")).toBeInTheDocument();
    expect(await screen.findByText("Sign in to upload a vocal.")).toBeInTheDocument();
    expect(screen.getByLabelText("Captured vocal")).toHaveAttribute("src", "blob:voice-take");
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.getByTestId("selected-persona")).toHaveTextContent("");
  });

  it("re-record revokes the preview and clears the selected reference", async () => {
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(21_000);
    await waitFor(() => expect(screen.getByTestId("selected-vocal-url").textContent).toMatch(/^https:\/\//));
    fireEvent.click(screen.getByRole("button", { name: "Re-record" }));
    expect(revokeUrl).toHaveBeenCalledWith("blob:voice-take");
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.getByTestId("selected-persona")).toHaveTextContent("");
    expect(screen.queryByLabelText("Captured vocal")).not.toBeInTheDocument();
    expect(screen.queryByText(/Voice Captured/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("does not apply a late upload after re-record", async () => {
    let releaseUpload: (value: { error: null }) => void = () => undefined;
    upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseUpload = resolve;
        }),
    );
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(22_000);
    expect(await screen.findByText("✓ Voice Captured 22s")).toBeInTheDocument();
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    fireEvent.click(screen.getByRole("button", { name: "Re-record" }));
    releaseUpload({ error: null });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.queryByText(/Voice Captured/)).not.toBeInTheDocument();
  });
});
