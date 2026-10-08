import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CharacterModal, { type SelectedVocal, type VocalCharacter } from "./CharacterModal";

const SHORT_TAKE_WARNING = "Sonic requires at least 15 seconds of audio for accurate voice profiling.";
const LIVE_MIC_COPY = "Live mic capture (15–30s take).";
const USER_ID = "user-1";
const UPLOADED_URL = `https://project.supabase.co/storage/v1/object/public/audio-vault/vocal-references/${USER_ID}/voice-take-1700000021000.wav`;
const UPLOADED_NAME = "voice-take-1700000021000.wav";

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

class FakeAudioBuffer {
  numberOfChannels = 1;
  sampleRate = 44100;
  length = 4;
  duration = 4 / 44100;
  getChannelData() {
    return new Float32Array([0, 0.5, -0.5, 1]);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "running";
  decodeAudioData = vi.fn(async () => new FakeAudioBuffer());
  close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

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
  const [vocal, setVocal] = useState<SelectedVocal | null>(null);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  return (
    <div>
      <p data-testid="selected-vocal-url">{vocal?.url ?? ""}</p>
      <p data-testid="selected-vocal-name">{vocal?.name ?? ""}</p>
      <p data-testid="selected-vocal-duration">{vocal ? String(vocal.duration) : ""}</p>
      <p data-testid="selected-vocal-ready">{vocal?.isReady ? "yes" : ""}</p>
      <p data-testid="selected-persona">{characterId ?? ""}</p>
      <p data-testid="modal-open">{open ? "yes" : "no"}</p>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen studio
      </button>
      <CharacterModal
        isOpen={open}
        onClose={() => setOpen(false)}
        characters={CHARACTERS}
        selectedCharacterId={characterId}
        onSelectCharacter={(character) => setCharacterId(character.id)}
        selectedSourceUrl={vocal?.url ?? null}
        onSelectVocal={setVocal}
      />
    </div>
  );
}

type StudioResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function tracksResponse(): StudioResponse {
  return {
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => ({ tracks: [] }),
    text: async (): Promise<string> => "{}",
  };
}

function uploadResult(url = UPLOADED_URL, fileName = UPLOADED_NAME, ok = true): StudioResponse {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async (): Promise<unknown> => (ok ? { url, fileName } : { error: "Could not save this vocal take." }),
    text: async (): Promise<string> => "{}",
  };
}

describe("CharacterModal voice capture", () => {
  let now = 1_700_000_000_000;
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
  let revokeUrl: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<StudioResponse>>>;

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
    FakeAudioContext.instances = [];
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<StudioResponse> => {
      if (String(input).includes("/api/vocals/upload")) return uploadResult();
      return tracksResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
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
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);

    now += 15_000;
    const limit = timeoutSpy.mock.calls.find((call) => call[1] === 30_000);
    expect(limit).toBeTruthy();
    act(() => {
      (limit![0] as () => void)();
    });

    expect(await screen.findByText("✓ Voice Captured 30s")).toBeInTheDocument();
    expect(screen.queryByText(SHORT_TAKE_WARNING)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Captured vocal").tagName).toBe("AUDIO");
    expect(screen.getByLabelText("Captured vocal")).toHaveAttribute("src", "blob:voice-take");
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock In Vocal Take" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Apply Vocal to Song" })).not.toBeInTheDocument();
    expect(screen.queryByText("Staging vocal reference...")).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
    expect(storageFrom).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.getByTestId("selected-vocal-name")).toHaveTextContent("");
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
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(screen.getByRole("button", { name: /My Voice - October 5/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.getByTestId("selected-persona")).toHaveTextContent("");
    await act(async () => {
      await Promise.resolve();
    });
    expect(upload).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
  });

  it("accepts a stop at 15 seconds", async () => {
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(15_000);
    expect(await screen.findByText("✓ Voice Captured 15s")).toBeInTheDocument();
    expect(screen.queryByText(SHORT_TAKE_WARNING)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock In Vocal Take" })).toBeInTheDocument();
    expect(screen.getByTestId("selected-vocal-duration")).toHaveTextContent("");
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/vocals/upload"))).toHaveLength(0);
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("renders the captured card and uploads a 21s take to the user folder", async () => {
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(21_000);
    const badge = await screen.findByText("✓ Voice Captured 21s");
    const card = screen.getByLabelText("Captured Vocal");
    expect(screen.getByRole("heading", { name: "Record / Input Your Voice" }).closest("section")).toContainElement(card);
    expect(card).toContainElement(badge);
    const audio = screen.getByLabelText("Captured vocal");
    expect(audio.tagName).toBe("AUDIO");
    expect(audio).toHaveAttribute("src", "blob:voice-take");
    expect(screen.getByRole("button", { name: "Re-record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(document.querySelector("canvas")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/vocals/upload"))).toHaveLength(0);
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");

    fireEvent.click(screen.getByRole("button", { name: "Lock In Vocal Take" }));
    expect(await screen.findByText("✓ Vocal Ready")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/vocals/upload"))).toHaveLength(1));
    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/vocals/upload")) as unknown as [
      string,
      RequestInit,
    ];
    expect(uploadCall[0]).toBe("/api/vocals/upload");
    const headers = uploadCall[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-token");
    const forcedType = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1];
    expect(forcedType).toBeUndefined();
    expect(forcedType).not.toBe("multipart/form-data");
    expect(uploadCall[1].body).toBeInstanceOf(FormData);
    const posted = (uploadCall[1].body as FormData).get("audio");
    expect(posted).toBeInstanceOf(File);
    expect((posted as File).name).toBe("vocal-take.wav");
    expect((posted as File).type).toBe("audio/wav");
    const postedBytes = new Uint8Array(await (posted as File).arrayBuffer());
    expect(String.fromCharCode(...postedBytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...postedBytes.subarray(8, 12))).toBe("WAVE");
    expect((posted as File).type).not.toBe("audio/webm");
    expect(storageFrom).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("modal-open")).toHaveTextContent("no"));
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent(UPLOADED_URL);
    expect(screen.getByTestId("selected-vocal-name")).toHaveTextContent("Take 1");
    expect(screen.getByTestId("selected-vocal-duration")).toHaveTextContent("21");
    expect(screen.getByTestId("selected-vocal-ready")).toHaveTextContent("yes");
    expect(screen.queryByText("Upload failed.")).not.toBeInTheDocument();
    expect(screen.getByTestId("selected-persona")).toHaveTextContent("");
    expect(UPLOADED_URL.startsWith("https://")).toBe(true);
    expect(UPLOADED_URL).toContain("/audio-vault/");
    expect(UPLOADED_URL).not.toMatch(/^blob:/);
    expect(screen.getByTestId("selected-vocal-url").textContent).not.toMatch(/^blob:/);
  });

  it("keeps the local preview when upload fails or the public URL is not an audio-vault https URL", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/vocals/upload")) {
        return {
          ok: false,
          status: 500,
          json: async (): Promise<unknown> => ({ error: "row-level security" }),
          text: async (): Promise<string> => "{}",
        };
      }
      return tracksResponse();
    });
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(21_000);
    expect(await screen.findByText("✓ Voice Captured 21s")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Lock In Vocal Take" }));
    expect(await screen.findByText("Could not save this vocal take.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock In Vocal Take" })).toBeEnabled();
    expect(screen.queryByText("Upload failed.")).not.toBeInTheDocument();
    expect(screen.queryByText("✓ Uploaded & Ready")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Captured vocal")).toHaveAttribute("src", "blob:voice-take");
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.queryByText(/row-level security/)).not.toBeInTheDocument();
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it.each([
    "http://project.supabase.co/storage/v1/object/public/audio-vault/vocal-references/user-1/take.wav",
    "blob:http://127.0.0.1/take",
    "https://cdn.example/vocal.wav",
  ])("does not select %s", async (publicUrl) => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/vocals/upload")) return uploadResult(publicUrl, "take.wav");
      return tracksResponse();
    });
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(18_000);
    expect(await screen.findByText("✓ Voice Captured 18s")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Lock In Vocal Take" }));
    expect(await screen.findByText("Could not save this vocal take.")).toBeInTheDocument();
    expect(screen.queryByText("Upload failed.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Captured vocal")).toHaveAttribute("src", "blob:voice-take");
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
  });

  it("previews a valid take when signed out and does not upload it", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(16_000);
    expect(await screen.findByText("✓ Voice Captured 16s")).toBeInTheDocument();
    expect(screen.queryByText("Sign in to upload a vocal.")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Lock In Vocal Take" }));
    expect(await screen.findByText("Sign in to upload a vocal.")).toBeInTheDocument();
    expect(screen.getByLabelText("Captured vocal")).toHaveAttribute("src", "blob:voice-take");
    expect(upload).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.getByTestId("selected-persona")).toHaveTextContent("");
  });

  it("re-record revokes the preview and clears the selected reference", async () => {
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(21_000);
    expect(await screen.findByText("✓ Voice Captured 21s")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Lock In Vocal Take" }));
    await waitFor(() => expect(screen.getByTestId("selected-vocal-url").textContent).toMatch(/^https:\/\//));
    expect(screen.getByTestId("selected-vocal-name")).toHaveTextContent("Take 1");
    fireEvent.click(screen.getByRole("button", { name: "Reopen studio" }));
    fireEvent.click(screen.getByRole("button", { name: "Re-record" }));
    expect(revokeUrl).toHaveBeenCalledWith("blob:voice-take");
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.getByTestId("selected-persona")).toHaveTextContent("");
    expect(screen.queryByLabelText("Captured vocal")).not.toBeInTheDocument();
    expect(screen.queryByText(/Voice Captured/)).not.toBeInTheDocument();
    expect(screen.queryByText("✓ Uploaded & Ready")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("does not apply a late upload after re-record", async () => {
    let releaseUpload: (value: StudioResponse) => void = () => undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes("/api/vocals/upload")) {
        return new Promise<StudioResponse>((resolve) => {
          releaseUpload = resolve;
        });
      }
      return Promise.resolve(tracksResponse());
    });
    render(<StudioHarness />);
    await beginRecording();
    stopAfter(22_000);
    expect(await screen.findByText("✓ Voice Captured 22s")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Lock In Vocal Take" }));
    expect(await screen.findByText("Staging vocal reference...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock In Vocal Take" })).toBeDisabled();
    expect(screen.queryByText("✓ Vocal Ready")).not.toBeInTheDocument();
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    fireEvent.click(screen.getByRole("button", { name: "Re-record" }));
    releaseUpload({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => ({ url: UPLOADED_URL, fileName: UPLOADED_NAME }),
      text: async (): Promise<string> => "{}",
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("selected-vocal-url")).toHaveTextContent("");
    expect(screen.queryByText(/Voice Captured/)).not.toBeInTheDocument();
    expect(screen.queryByText("✓ Uploaded & Ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Upload failed.")).not.toBeInTheDocument();
    expect(storageFrom).not.toHaveBeenCalled();
  });
});
