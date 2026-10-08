import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MUREKA_TEMPLATES } from "@/data/murekaTemplates";

const { getSession, onAuthStateChange, upload, getPublicUrl, from } = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  upload: vi.fn(async () => ({ error: null })),
  getPublicUrl: vi.fn((path: string) => ({
    data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/audio-vault/${path}` },
  })),
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession, onAuthStateChange },
    from,
    storage: {
      from: vi.fn(() => ({
        getPublicUrl,
        upload,
      })),
    },
  },
}));

import { EnginePage } from "./EnginePage";

function jsonResult(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("EnginePage instrumental tab", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    getSession.mockReset();
    onAuthStateChange.mockClear();
    upload.mockReset();
    upload.mockResolvedValue({ error: null });
    getPublicUrl.mockReset();
    getPublicUrl.mockImplementation((path: string) => ({
      data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/audio-vault/${path}` },
    }));
    from.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockResolvedValue({ data: { session: null } });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/generate")) {
        return jsonResult({
          success: true,
          status: "ready",
          wavUrl: "https://example.com/storage/v1/object/public/audio-vault/masters/ready.wav",
        });
      }
      return jsonResult({ tracks: [] });
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders Instrumental, fills the vibe from a template, and posts isInstrumental", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);

    const instrumentalVocal = screen.getByRole("button", { name: "+ Vocal" });
    expect(instrumentalVocal).toBeDisabled();
    expect(instrumentalVocal).toHaveAttribute("title", "Vocals disabled in Instrumental mode");
    fireEvent.click(instrumentalVocal);
    expect(screen.queryByRole("heading", { name: "Vocal Studio" })).not.toBeInTheDocument();

    expect(screen.getByRole("tab", { name: "Instrumental", selected: true })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Easy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /make a beat/i })).not.toBeInTheDocument();

    const vibe = screen.getByRole("textbox", { name: "What's the vibe?" });
    expect(vibe).toHaveAttribute(
      "placeholder",
      "Describe a vibe, tempo, or instruments (e.g., 90 BPM lo-fi hip hop with Rhodes piano & upright bass)...",
    );
    expect(screen.getByRole("button", { name: "Enhance Vibe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3 min", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30 sec" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 min 30 sec" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3 min 30 sec" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "4 min" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "5 min" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "6 min" })).toBeInTheDocument();
    const lengthSlider = screen.getByRole("slider", { name: "Track length slider" });
    expect(lengthSlider).toHaveAttribute("max", "360");
    expect(screen.getByLabelText("Track Length (Seconds)")).toHaveValue(180);

    const grunge = MUREKA_TEMPLATES.find((template) => template.title === "Heavy Grunge Acoustic");
    expect(grunge?.prompt).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Heavy Grunge Acoustic/ }));
    expect(vibe).toHaveValue(grunge!.prompt);

    await user.click(screen.getByRole("button", { name: "6 min" }));
    expect(screen.getByLabelText("Track Length (Seconds)")).toHaveValue(360);
    expect(screen.getByRole("slider", { name: "Track length slider" })).toHaveValue("360");

    await user.click(screen.getByRole("button", { name: "30 sec" }));
    expect(screen.getByLabelText("Track Length (Seconds)")).toHaveValue(30);

    await user.click(screen.getByRole("button", { name: "Render Master Record" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/generate"))).toBe(true));
    const generateCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/generate")) as [string, RequestInit];
    expect(generateCall[0]).toBe("/api/generate");
    const body = JSON.parse(String(generateCall[1].body)) as {
      prompt: string;
      stylePrompt: string;
      isInstrumental: boolean;
      vocal_id?: string;
      reference_id?: string;
      seed?: number;
      webhook?: string;
    };
    expect(body.prompt).toBe(grunge!.prompt);
    expect(body.stylePrompt).toBe(grunge!.prompt);
    expect(body.isInstrumental).toBe(true);
    expect(body.vocal_id).toBeUndefined();
    expect(body.reference_id).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.webhook).toBeUndefined();
    expect(body).not.toHaveProperty("duration");
    expect(body).not.toHaveProperty("reference_audio_url");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/generate"))).toBe(false);
  });

  it("enhances an instrumental vibe through enhance_style and keeps the draft when it fails", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);
    const vibe = screen.getByRole("textbox", { name: "What's the vibe?" });

    let releaseEnhance: (value: ReturnType<typeof jsonResult>) => void = () => {};
    const pendingEnhance = new Promise<ReturnType<typeof jsonResult>>((resolve) => {
      releaseEnhance = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ai/coproducer")) return pendingEnhance;
      return jsonResult({ tracks: [] });
    });

    await user.click(screen.getByRole("button", { name: "Enhance Vibe" }));
    const enhancing = screen.getByRole("button", { name: "Enhancing..." });
    expect(enhancing).toBeDisabled();
    expect(enhancing).toHaveAttribute("aria-busy", "true");

    const expanded = "92 BPM dusty Rhodes piano, upright bass, warm tape hiss, swung pocket";
    releaseEnhance(jsonResult({ success: true, style: expanded, prompt: expanded }));
    await waitFor(() => expect(vibe).toHaveValue(expanded));
    expect(screen.getByRole("button", { name: "Enhance Vibe" })).toBeEnabled();

    const coproducerCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/ai/coproducer")) as
      | [string, RequestInit]
      | undefined;
    expect(coproducerCall?.[0]).toBe("/api/ai/coproducer");
    const emptyBody = JSON.parse(String(coproducerCall?.[1].body)) as { action: string; prompt: string; lyrics: string };
    expect(emptyBody.action).toBe("enhance_style");
    expect(emptyBody.lyrics).toBe("");
    expect(emptyBody.prompt).toMatch(/sound designer/i);
    expect(emptyBody.prompt).toMatch(/BPM/);
    expect(emptyBody.prompt).toMatch(/instrumentation/i);
    expect(screen.getByRole("tab", { name: "Instrumental" }).parentElement?.textContent ?? "").not.toMatch(
      /wavespeed|replicate|claude|aimusic/i,
    );

    await user.clear(vibe);
    await user.type(vibe, "rainy loft");
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ai/coproducer")) return jsonResult({ error: "Replicate Claude failed the request" }, 500);
      return jsonResult({ tracks: [] });
    });
    await user.click(screen.getByRole("button", { name: "Enhance Vibe" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Could not enhance that vibe.");
    expect(notice.textContent).not.toMatch(/wavespeed|replicate|claude|aimusic/i);
    expect(vibe).toHaveValue("rainy loft");

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ai/coproducer")) {
        return jsonResult({ success: true, style: "74 BPM brushed kit, warm upright bass, analog room", prompt: "ok" });
      }
      return jsonResult({ tracks: [] });
    });
    await user.click(screen.getByRole("button", { name: "Enhance Vibe" }));
    await waitFor(() =>
      expect(vibe).toHaveValue("74 BPM brushed kit, warm upright bass, analog room"),
    );
    const filledCall = [...fetchMock.mock.calls]
      .reverse()
      .find(([url]) => String(url).includes("/api/ai/coproducer")) as [string, RequestInit];
    const filledBody = JSON.parse(String(filledCall[1].body)) as { action: string; prompt: string; lyrics: string };
    expect(filledBody.action).toBe("enhance_style");
    expect(filledBody.lyrics).toBe("");
    expect(filledBody.prompt).toContain("rainy loft");
    expect(filledBody.prompt).toMatch(/sound designer/i);
  });

  it("keeps Without Vocals locked and opens Vocal Studio on With Vocals", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);

    await user.click(screen.getByRole("tab", { name: "Without Vocals" }));
    const locked = screen.getByRole("button", { name: "+ Vocal" });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute("title", "Vocals disabled in instrumental mode");
    expect(screen.getByRole("button", { name: "6 min" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Render Master Record" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Song title" })).toHaveAttribute("placeholder", "Enter song title");

    await user.click(screen.getByRole("tab", { name: "With Vocals" }));
    const vocal = screen.getByRole("button", { name: "+ Vocal" });
    expect(vocal).toBeEnabled();
    await user.click(vocal);
    expect(screen.getByRole("heading", { name: "Vocal Studio" })).toBeInTheDocument();
    expect(screen.getByText("Select, record, or inject a vocal into your production")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Record / Input Your Voice" })).toBeInTheDocument();
    expect(screen.getByText("Live mic capture (15–30s take).")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Vocal Swap / Track Inject" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\+ Add Vocal/ })).not.toBeInTheDocument();
    const engineSource = readFileSync(join(process.cwd(), "src/components/EnginePage.tsx"), "utf8");
    const characterSource = readFileSync(join(process.cwd(), "src/components/studio/CharacterModal.tsx"), "utf8");
    const vocalTabSource = readFileSync(join(process.cwd(), "src/components/studio/VocalStudioTab.tsx"), "utf8");
    expect(engineSource).not.toMatch(/hasProLicense/);
    expect(characterSource).not.toMatch(/hasProLicense/);
    expect(vocalTabSource).not.toMatch(/hasProLicense/);
    expect(engineSource).not.toMatch(/VocalUpgradeModal/);
    expect(screen.queryByText("Pro")).not.toBeInTheDocument();
    expect(screen.queryByText(/5[- ]token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/unlock/i)).not.toBeInTheDocument();
    expect(screen.getByText("Click or drag & drop a .wav or .mp3 track here.")).toBeInTheDocument();
    expect(screen.getByText("Or select from your Audio Vault:")).toBeInTheDocument();
    const voiceTitle = screen.getByText("Input Voice / Mic Capture");
    expect(voiceTitle.className).toContain("text-white");
    expect(voiceTitle.closest("section")?.className ?? "").not.toMatch(/cyan/);
    expect(screen.getByRole("button", { name: /My Voice - October 5/ })).toBeInTheDocument();
    const overlay = screen.getByRole("heading", { name: "Vocal Studio" }).closest(".fixed");
    expect(overlay?.className).toContain("bg-black/85");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Vocal Studio" })).not.toBeInTheDocument();
  });

  it("covers the screen with the templates overlay and keeps genre pills outside the card scroller", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);

    await user.click(screen.getByRole("button", { name: /View more/ }));
    const dialog = screen.getByRole("dialog", { name: "Templates" });
    expect(dialog.parentElement).toHaveClass("fixed", "inset-0", "z-50", "bg-black/90", "backdrop-blur-md");
    expect(screen.getByText(/Showing \d+ production presets/)).toBeInTheDocument();
    const genres = screen.getByRole("group", { name: "Genres" });
    expect(genres.className).toContain("mt-4");
    expect(genres.parentElement?.querySelector(".pt-6")).toBeTruthy();
    const rock = screen.getByRole("button", { name: "Rock" });
    const scroller = screen.getByLabelText("Production presets");
    expect(scroller.className).toContain("max-h-[80vh]");
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.contains(rock)).toBe(false);
    expect(screen.getByRole("button", { name: "Hip-hop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Electronic" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drill" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Templates" })).not.toBeInTheDocument();
  });

  it("sends a captured audio-vault take as the With Vocals reference", async () => {
    const user = userEvent.setup();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-take");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    FakeMediaRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    const previousMedia = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }));
    const publicUrl =
      "https://project.supabase.co/storage/v1/object/public/audio-vault/vocal-references/user-1/voice-take-1700000021000.wav";
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/vocals/upload")) {
        return jsonResult({ url: publicUrl, fileName: "voice-take-1700000021000.wav" });
      }
      if (url.includes("/api/vocals/generate")) return jsonResult({ success: true, taskId: "task-vocal-take" });
      if (url.includes("/api/generate")) {
        return jsonResult({
          success: true,
          status: "ready",
          wavUrl: "https://example.com/storage/v1/object/public/audio-vault/masters/ready.wav",
        });
      }
      if (url.includes("/api/user/balance")) return jsonResult({ balance: 2 });
      return jsonResult({ tracks: [] });
    });

    try {
      render(<EnginePage />);
      await user.click(screen.getByRole("tab", { name: "With Vocals" }));
      await user.click(screen.getByRole("button", { name: "+ Vocal" }));
      expect(screen.getByText("Live mic capture (15–30s take).")).toBeInTheDocument();
      expect(FakeMediaRecorder.instances).toHaveLength(0);
      expect(getUserMedia).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Record" }));
      await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
      expect(FakeMediaRecorder.instances[0]!.start).toHaveBeenCalledTimes(1);
      now += 21_000;
      fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

      expect(await screen.findByText("✓ Voice Captured 21s")).toBeInTheDocument();
      const audio = screen.getByLabelText("Captured vocal");
      expect(audio.tagName).toBe("AUDIO");
      expect((audio as HTMLAudioElement).controls).toBe(true);
      expect(audio).toHaveAttribute("src", "blob:voice-take");
      expect(screen.getByRole("button", { name: "Re-record" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /My Voice - October 5/ })).toHaveAttribute("aria-pressed", "false");

      const activeVocal = /Active Vocal: My Voice Take \(21s\)/;
      await waitFor(() => expect(screen.getByText(activeVocal)).toBeInTheDocument());
      expect(screen.queryByText("Upload failed.")).not.toBeInTheDocument();
      expect(upload).not.toHaveBeenCalled();
      const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/vocals/upload")) as unknown as [
        string,
        RequestInit,
      ];
      expect(uploadCall[0]).toBe("/api/vocals/upload");
      expect((uploadCall[1].headers as Record<string, string>).Authorization).toBe("Bearer session-token");
      expect(uploadCall[1].body).toBeInstanceOf(FormData);
      expect((uploadCall[1].body as FormData).get("audio")).toBeTruthy();

      fireEvent.change(screen.getByRole("textbox", { name: "Lyrics" }), { target: { value: "hello line" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Style" }), { target: { value: "dry vocal" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Song title" }), { target: { value: "Night Drive" } });
      expect(screen.getByText(activeVocal)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Apply Vocal to Song" }));
      expect(screen.queryByRole("heading", { name: "Vocal Studio" })).not.toBeInTheDocument();
      expect(screen.getByText(activeVocal)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "✓ My Voice Take" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Render Master Record" }));
      await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/generate"))).toBe(true));
      const generateCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/vocals/generate")) as unknown as [
        string,
        RequestInit,
      ];
      const body = JSON.parse(String(generateCall[1].body)) as {
        reference_audio_url?: string;
        vocalAudioUrl?: string;
        personaId?: string;
      };
      expect(body.reference_audio_url).toBe(publicUrl);
      expect(body).not.toHaveProperty("vocalAudioUrl");
      expect(body).not.toHaveProperty("personaId");
      expect(body.reference_audio_url).not.toMatch(/^blob:/);
      expect(body.reference_audio_url).not.toMatch(/^http:/);
      expect(screen.getByText(activeVocal)).toBeInTheDocument();

      await user.click(screen.getByRole("tab", { name: "Instrumental" }));
      expect(screen.queryByText(activeVocal)).not.toBeInTheDocument();
      fireEvent.change(screen.getByRole("textbox", { name: "What's the vibe?" }), { target: { value: "soft piano" } });
      await user.click(screen.getByRole("button", { name: "Render Master Record" }));
      await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/generate"))).toBe(true));
      const instrumentalCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/generate")) as unknown as [
        string,
        RequestInit,
      ];
      const instrumentalBody = JSON.parse(String(instrumentalCall[1].body)) as Record<string, unknown>;
      expect(instrumentalBody).not.toHaveProperty("reference_audio_url");
      expect(instrumentalBody.isInstrumental).toBe(true);

      await user.click(screen.getByRole("tab", { name: "With Vocals" }));
      expect(screen.getByText(activeVocal)).toBeInTheDocument();
      await user.type(screen.getByRole("textbox", { name: "Lyrics" }), "hello line");
      await user.click(screen.getByRole("button", { name: "Change" }));
      expect(screen.getByRole("heading", { name: "Vocal Studio" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByText(activeVocal)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(screen.queryByText(activeVocal)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Render Master Record" }));
      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/vocals/generate"))).toHaveLength(2),
      );
      const clearedCall = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/vocals/generate")).at(-1) as unknown as [
        string,
        RequestInit,
      ];
      const cleared = JSON.parse(String(clearedCall[1].body)) as Record<string, unknown>;
      expect(cleared).not.toHaveProperty("reference_audio_url");
      expect(cleared).not.toHaveProperty("vocalAudioUrl");
    } finally {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: previousMedia });
    }
  });
});

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
