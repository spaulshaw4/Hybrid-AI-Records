import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MUREKA_TEMPLATES } from "@/data/murekaTemplates";

const { getSession, onAuthStateChange, upload, getPublicUrl, from } = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  upload: vi.fn(
    async (
      _path: string,
      _body: Blob,
      _options?: { contentType?: string; upsert?: boolean },
    ): Promise<{ error: { message: string; statusCode?: string } | null }> => ({
      error: null,
    }),
  ),
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

import { EnginePage, formatVocalReferenceClock } from "./EnginePage";
import * as CharacterModalModule from "@/components/studio/CharacterModal";

function jsonResult(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** fmt + data PCM: 16-bit, mono, 24000 Hz, at most 30 seconds. */
async function expectReferencePcmWav(blob: Blob) {
  expect(blob.type).toBe("audio/wav");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  expect(text(0, 4)).toBe("RIFF");
  expect(text(8, 12)).toBe("WAVE");
  expect(text(12, 16)).toBe("fmt ");
  expect(text(36, 40)).toBe("data");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(16, true)).toBe(16);
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(24_000);
  expect(view.getUint16(34, true)).toBe(16);
  const dataSize = view.getUint32(40, true);
  expect(bytes.byteLength).toBe(44 + dataSize);
  const duration = dataSize / 2 / 24_000;
  expect(duration).toBeLessThanOrEqual(30);
  return duration;
}

async function confirmReferenceClip(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole("button", { name: "Use Clip" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

describe("EnginePage instrumental tab", () => {
  it("formats a docked vocal duration as m:ss", () => {
    expect(formatVocalReferenceClock(29)).toBe("0:29");
    expect(formatVocalReferenceClock(30)).toBe("0:30");
    expect(formatVocalReferenceClock(21)).toBe("0:21");
    expect(formatVocalReferenceClock(75)).toBe("1:15");
  });

  const fetchMock = vi.fn();

  beforeEach(() => {
    cleanup();
    const proto = HTMLElement.prototype;
    if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
    if (!proto.setPointerCapture) proto.setPointerCapture = () => undefined;
    if (!proto.releasePointerCapture) proto.releasePointerCapture = () => undefined;
    if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;
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
    FakeAudioContext.instances = [];
    FakeAudioContext.decoded = null;
    FakeAudioContext.failDecode = false;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockResolvedValue({ data: { session: null } });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
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
      provider?: string;
      model?: string;
      vocal_id?: string;
      vocalId?: string;
      reference_id?: string;
      seed?: number;
      webhook?: string;
    };
    expect(body.prompt).toBe(grunge!.prompt);
    expect(body.stylePrompt).toBe(grunge!.prompt);
    expect(body.isInstrumental).toBe(true);
    expect(body.provider).toBe("wavespeed");
    expect(body.model).toBe("mureka-9.5");
    expect(body.vocal_id).toBeUndefined();
    expect(body).not.toHaveProperty("vocalId");
    expect(body.reference_id).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.webhook).toBeUndefined();
    expect(body).not.toHaveProperty("duration");
    expect(body).not.toHaveProperty("reference_audio_url");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/generate"))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/generate"))).toBe(false);
  });

  it("sends Vocals with AI to Mureka 9.5 and does not call the music API", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/vocals/generate")) return jsonResult({ success: true, taskId: "task-vocal-ai" });
      if (url.includes("/api/generate")) {
        return jsonResult({
          success: true,
          status: "ready",
          wavUrl: "https://example.com/storage/v1/object/public/audio-vault/masters/ready.wav",
        });
      }
      return jsonResult({ tracks: [] });
    });
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Style" }), { target: { value: "dry vocal, 90 BPM" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Lyrics" }), { target: { value: "hello line" } });
    await user.click(screen.getByRole("button", { name: "Render Master Record" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/generate")).toBe(true));
    const generateCalls = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/generate");
    expect(generateCalls).toHaveLength(1);
    const generateCall = generateCalls[0] as [string, RequestInit];
    expect(generateCall[0]).toBe("/api/generate");
    const body = JSON.parse(String(generateCall[1].body)) as Record<string, unknown>;
    expect(body.lyrics).toBe("hello line");
    expect(body.prompt).toBe("dry vocal, 90 BPM");
    expect(body.stylePrompt).toBe("dry vocal, 90 BPM");
    expect(body.provider).toBe("wavespeed");
    expect(body.model).toBe("mureka-9.5");
    expect(body.gender).toBe("male");
    expect(body).not.toHaveProperty("isInstrumental");
    expect(body).not.toHaveProperty("reference_audio_url");
    expect(body).not.toHaveProperty("vocalId");
    expect(body).not.toHaveProperty("vocal_id");
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("webhook");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/generate"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => /wavespeed\.ai/i.test(String(url)))).toBe(false);
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

  it("keeps Vocals with AI locked and opens Vocal Studio on With Vocals", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);

    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
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
    vi.stubGlobal("AudioContext", FakeAudioContext);
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
      expect(audio).toHaveAttribute("src", "blob:voice-take");
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Re-record" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Lock In Vocal Take" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /My Voice - October 5/ })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByText("Live mic capture (15–30s take).")).toBeInTheDocument();

      const activeVocal = "🎙️ Active Vocal Reference: Take 1 (0:21)";
      expect(screen.queryByText(activeVocal)).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
      expect(upload).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Lock In Vocal Take" }));
      await waitFor(() => expect(screen.getByText(activeVocal)).toBeInTheDocument(), { timeout: 2000 });
      expect(screen.queryByRole("heading", { name: "Vocal Studio" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "✓ Take 1" })).toBeInTheDocument();
      const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/vocals/upload")) as unknown as [
        string,
        RequestInit,
      ];
      expect(uploadCall[0]).toBe("/api/vocals/upload");
      expect((uploadCall[1].headers as Record<string, string>).Authorization).toBe("Bearer session-token");
      expect(Object.keys(uploadCall[1].headers as Record<string, string>).some((key) => key.toLowerCase() === "content-type")).toBe(false);
      expect(uploadCall[1].body).toBeInstanceOf(FormData);
      expect((uploadCall[1].body as FormData).get("audio")).toBeTruthy();
      const posted = (uploadCall[1].body as FormData).get("audio") as File;
      expect(posted.name).toBe("vocal-take.wav");
      expect(posted.type).toBe("audio/wav");
      const forcedType = Object.entries(uploadCall[1].headers as Record<string, string>).find(
        ([key]) => key.toLowerCase() === "content-type",
      )?.[1];
      expect(forcedType).toBeUndefined();

      const vocalsForm = screen.getByRole("form", { name: "With Vocals" });
      const lyricsBox = screen.getByRole("textbox", { name: "Lyrics" });
      expect(vocalsForm).toHaveTextContent(activeVocal);
      expect(screen.getByText(activeVocal).compareDocumentPosition(lyricsBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(vocalsForm).toContainElement(screen.getByRole("textbox", { name: "Style" }));
      expect(vocalsForm).toContainElement(screen.getByLabelText("Track Length"));
      expect(screen.getByRole("region", { name: "Your Audio Vault" })).not.toHaveTextContent("Active Vocal Reference");
      expect(screen.getByLabelText("Active vocal reference")).toHaveAttribute("src", publicUrl);

      fireEvent.change(screen.getByRole("textbox", { name: "Lyrics" }), { target: { value: "hello line" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Style" }), { target: { value: "dry vocal" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Song title" }), { target: { value: "Night Drive" } });
      expect(screen.getByText(activeVocal)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Render Master Record" }));
      await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/generate"))).toBe(true));
      const generateCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/vocals/generate")) as unknown as [
        string,
        RequestInit,
      ];
      expect(generateCall[0]).toBe("/api/vocals/generate");
      const body = JSON.parse(String(generateCall[1].body)) as {
        reference_audio_url?: string;
        vocalAudioUrl?: string;
        personaId?: string;
        provider?: string;
        model?: string;
      };
      expect(body.reference_audio_url).toBe(publicUrl);
      expect(body).not.toHaveProperty("vocalAudioUrl");
      expect(body).not.toHaveProperty("personaId");
      expect(body).not.toHaveProperty("provider");
      expect(body).not.toHaveProperty("model");
      expect(body.reference_audio_url).not.toMatch(/^blob:/);
      expect(body.reference_audio_url).not.toMatch(/^http:/);
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/generate")).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => /wavespeed/i.test(String(url)))).toBe(false);
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
      expect(instrumentalBody).not.toHaveProperty("vocalId");
      expect(instrumentalBody.isInstrumental).toBe(true);
      expect(instrumentalBody.provider).toBe("wavespeed");
      expect(instrumentalBody.model).toBe("mureka-9.5");
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/generate")).toHaveLength(1);

      await user.click(screen.getByRole("tab", { name: "With Vocals" }));
      expect(screen.getByText(activeVocal)).toBeInTheDocument();
      await user.type(screen.getByRole("textbox", { name: "Lyrics" }), "hello line");
      await user.click(screen.getByRole("button", { name: "✓ Take 1" }));
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

  it("keeps lyrics and render inside the glass studio and the audio vault outside", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);

    const glass = screen.getByTestId("patriot-glass-studio");
    expect(glass).toHaveClass("relative", "group", "max-w-4xl");
    expect(glass).toContainElement(screen.getByRole("tab", { name: "With Vocals" }));
    expect(glass).toContainElement(screen.getByRole("button", { name: "Render Master Record" }));
    expect(glass).toContainElement(screen.getByRole("slider", { name: "Track length slider" }));

    const vault = screen.getByRole("region", { name: "Your Audio Vault" });
    expect(glass.contains(vault)).toBe(false);

    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    expect(glass).toContainElement(screen.getByText("Lyrics & Structure"));
    expect(glass).toContainElement(screen.getByRole("textbox", { name: "Lyrics" }));
    expect(glass).toContainElement(screen.getByRole("button", { name: "Render Master Record" }));
    expect(glass.contains(screen.getByRole("region", { name: "Your Audio Vault" }))).toBe(false);
  });

  it("shows one Hybrid Engine 2.0 badge and hides vocal gender on Instrumental", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);

    expect(screen.getAllByText("Hybrid Engine 2.0")).toHaveLength(1);
    const badge = screen.getByText("Hybrid Engine 2.0");
    const instrumentalTab = screen.getByRole("tab", { name: "Instrumental" });
    expect(badge.compareDocumentPosition(instrumentalTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(badge.closest(".mb-2")?.nextElementSibling).toBe(screen.getByRole("tablist", { name: "Studio mode" }));

    expect(screen.queryByRole("group", { name: "Vocal gender" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Female" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Male" })).not.toBeInTheDocument();
    expect(screen.queryByText("Vocal Gender")).not.toBeInTheDocument();
    expect(screen.queryByText("OFF (INSTRUMENTAL)")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    expect(screen.getAllByText("Hybrid Engine 2.0")).toHaveLength(1);
    expect(screen.queryByText("OFF (INSTRUMENTAL)")).not.toBeInTheDocument();
    const aiGender = screen.getByRole("group", { name: "Vocal gender" });
    expect(aiGender.className).not.toContain("pointer-events-none");
    expect(aiGender.className).not.toContain("opacity-35");
    expect(aiGender.parentElement?.className).toContain("p-4");
    expect(aiGender.parentElement?.parentElement?.className).toContain("items-start");
    expect(screen.getByRole("button", { name: "Female" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Male" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Female" }));
    expect(screen.getByRole("button", { name: "Female" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Female" }).className).toContain("bg-red-600");
    expect(screen.getByRole("button", { name: "Male" }).className).not.toContain("bg-red-600");
    expect(screen.queryByRole("checkbox", { name: "Instrumental" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear lyrics" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Studio Ghostwriter" })).toBeEnabled();
    expect(screen.queryByText("OFF (INSTRUMENTAL)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Female" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Female" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("tab", { name: "With Vocals" }));
    expect(screen.getAllByText("Hybrid Engine 2.0")).toHaveLength(1);
    expect(screen.queryByText("OFF (INSTRUMENTAL)")).not.toBeInTheDocument();
    const withGender = screen.getByRole("group", { name: "Vocal gender" });
    expect(withGender.className).not.toContain("pointer-events-none");
    expect(withGender.className).not.toContain("opacity-35");
    expect(screen.getByRole("button", { name: "Male" }).className).toContain("bg-red-600");
    expect(screen.getByRole("button", { name: "Female" }).className).toContain("bg-zinc-800/80");
    await user.click(screen.getByRole("button", { name: "Female" }));
    expect(screen.getByRole("button", { name: "Female" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Female" }).className).toContain("bg-red-600");
    expect(screen.getByRole("button", { name: "Male" }).className).not.toContain("bg-red-600");

    await user.click(screen.getByRole("tab", { name: "Instrumental" }));
    expect(screen.queryByRole("group", { name: "Vocal gender" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Female" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Male" })).not.toBeInTheDocument();
    expect(screen.queryByText("OFF (INSTRUMENTAL)")).not.toBeInTheDocument();
  });

  it("disables polish while the coproducer request is pending and for 2 seconds after", async () => {
    const user = userEvent.setup();
    let releasePolish: (value: ReturnType<typeof jsonResult>) => void = () => {};
    const pendingPolish = new Promise<ReturnType<typeof jsonResult>>((resolve) => {
      releasePolish = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ai/coproducer")) return pendingPolish;
      return jsonResult({ tracks: [] });
    });

    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    expect(screen.getByRole("tab", { name: "Instrumental" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Instrumental" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear lyrics" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Studio Ghostwriter" })).toBeEnabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Lyrics" }), { target: { value: "hello line" } });
    const polish = screen.getByRole("button", { name: "Format and polish lyrics" });
    expect(polish).toHaveTextContent("\u2726 Format & Polish");
    expect(polish).toBeEnabled();

    await user.click(polish);
    const polishing = screen.getByRole("button", { name: "Format and polish lyrics" });
    expect(polishing).toHaveTextContent("Polishing...");
    expect(polishing).toBeDisabled();

    fireEvent.click(polishing);
    const coproducerCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/ai/coproducer"));
    expect(coproducerCalls()).toHaveLength(1);
    const request = coproducerCalls()[0] as [string, RequestInit];
    expect(request[0]).toBe("/api/ai/coproducer");
    const body = JSON.parse(String(request[1].body)) as { action: string; lyrics: string };
    expect(body.action).toBe("format_lyrics");
    expect(body.lyrics).toBe("hello line");

    vi.useFakeTimers();
    await act(async () => {
      releasePolish(jsonResult({ lyrics: "[Chorus]\nhello line" }));
      await pendingPolish;
    });

    const cooling = screen.getByRole("button", { name: "Format and polish lyrics" });
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue("[Chorus]\nhello line");
    expect(cooling).toHaveTextContent("\u2726 Format & Polish");
    expect(cooling).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(screen.getByRole("button", { name: "Format and polish lyrics" })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const ready = screen.getByRole("button", { name: "Format and polish lyrics" });
    expect(ready).toBeEnabled();
    expect(ready).toHaveTextContent("\u2726 Format & Polish");
  });

  it("clears lyrics only after a second click", async () => {
    const user = userEvent.setup();
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    expect(screen.queryByRole("button", { name: "Clear lyrics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Instrumental" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Lyrics" }), { target: { value: "keep this verse" } });
    const clear = screen.getByRole("button", { name: "Clear lyrics" });
    expect(clear).toHaveAttribute("title", "Clear lyrics");
    expect(clear.className).toContain("text-muted-foreground");
    expect(clear.className).toContain("hover:text-destructive");
    await user.click(clear);
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue("keep this verse");

    const confirm = screen.getByRole("button", { name: "Confirm clear lyrics" });
    expect(confirm).toHaveAttribute("title", "Confirm clear lyrics");
    await user.click(confirm);
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear lyrics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm clear lyrics" })).not.toBeInTheDocument();
  });

  it("keeps vault playback private and does not offer reference or injection from the menu", async () => {
    const user = userEvent.setup();
    const mp3 =
      "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/glass.mp3";
    const wav =
      "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/glass.wav";
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () =>
              Promise.resolve({
                data: [
                  {
                    id: "vault-42",
                    title: "Glass Harbor",
                    prompt: "amber glass",
                    mp3_url: mp3,
                    wav_url: wav,
                    user_id: "user-1",
                  },
                ],
                error: null,
              }),
          }),
        }),
      }),
    }));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/vocals/generate")) return jsonResult({ success: true, taskId: "task-vocal-bed" });
      if (url.includes("/api/generate")) {
        return jsonResult({
          success: true,
          status: "ready",
          wavUrl: "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/ready.wav",
        });
      }
      if (url.includes("/api/user/balance")) return jsonResult({ balance: 2 });
      return jsonResult({ tracks: [] });
    });

    render(<EnginePage />);
    const vault = await screen.findByRole("region", { name: "Your Audio Vault" });
    expect(await screen.findByText("Glass Harbor")).toBeInTheDocument();
    const audio = vault.querySelector("audio");
    expect(audio).toHaveAttribute("controlsList", "nodownload noplaybackrate");
    expect(audio?.className).toContain("w-full");
    expect(audio?.className).toContain("h-8");
    expect(audio).toHaveAttribute("src", mp3);

    expect(screen.getByRole("button", { name: "+ Reference" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "\u2212 Minimize Vault" })).toBeInTheDocument();
    expect(screen.getByText("1 Master")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "\u2212 Minimize Vault" }));
    expect(screen.queryByText("Glass Harbor")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ Expand Vault" }));
    expect(screen.getByText("Glass Harbor")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Track options" }));
    expect(screen.queryByRole("menuitem", { name: "Use as Reference Track" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Track Injection (Swap)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Download Master" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download MP3" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download WAV" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete from Vault" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("tab", { name: "With Vocals" }));
    await user.click(screen.getByRole("button", { name: "+ Vocal" }));
    await user.click(screen.getByRole("button", { name: /My Voice - October 5/ }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "✓ My Voice - October 5" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "With Vocals", selected: true })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("create-voice"))).toBe(false);

    fireEvent.change(screen.getByRole("textbox", { name: "Lyrics" }), { target: { value: "hello line" } });
    await user.click(screen.getByRole("button", { name: "Render Master Record" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/generate"))).toBe(true));
    const vocalCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/vocals/generate")) as [string, RequestInit];
    const vocalBody = JSON.parse(String(vocalCall[1].body)) as {
      reference_audio_url?: string;
      personaId?: string;
    };
    expect(vocalCall[0]).toBe("/api/vocals/generate");
    expect(vocalBody).not.toHaveProperty("reference_audio_url");
    expect(vocalBody).not.toHaveProperty("provider");
    expect(vocalBody).not.toHaveProperty("model");
    expect(vocalBody.personaId).toBe("vocal_stephen_oct5_master");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/generate")).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => /wavespeed/i.test(String(url)))).toBe(false);

    const vocalCallsBeforeInstrumental = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/vocals/generate")).length;
    await user.click(screen.getByRole("tab", { name: "Instrumental" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What's the vibe?" }), { target: { value: "soft piano" } });
    await user.click(screen.getByRole("button", { name: "Render Master Record" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/generate"))).toBe(true));
    const instrumentalCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/generate")) as [string, RequestInit];
    const instrumentalBody = JSON.parse(String(instrumentalCall[1].body)) as Record<string, unknown>;
    expect(instrumentalBody).not.toHaveProperty("reference_audio_url");
    expect(instrumentalBody).not.toHaveProperty("webhook");
    expect(instrumentalBody).not.toHaveProperty("vocalId");
    expect(instrumentalBody.isInstrumental).toBe(true);
    expect(instrumentalBody.provider).toBe("wavespeed");
    expect(instrumentalBody.model).toBe("mureka-9.5");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/vocals/generate"))).toHaveLength(
      vocalCallsBeforeInstrumental,
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("create-voice"))).toBe(false);
  });

  it(
    "keeps a chosen reference on Vocals with AI and sends its style tags to Mureka 9.5",
    async () => {
    const user = userEvent.setup();
    const publicUrl =
      "https://project.supabase.co/storage/v1/object/public/audio-vault/vocal-references/user-1/reference-1.wav";
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
    const tags = "driving rock, analog synth, 120 bpm";
    let releaseAnalysis: (value: ReturnType<typeof jsonResult>) => void = () => {};
    const pendingAnalysis = new Promise<ReturnType<typeof jsonResult>>((resolve) => {
      releaseAnalysis = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/reference/audio-to-prompt")) return pendingAnalysis;
      if (url.includes("/api/vocals/reference")) return jsonResult({ url: publicUrl });
      if (url.includes("/api/vocals/upload")) return jsonResult({ error: "mic path" }, 400);
      if (url.includes("/api/vocals/generate")) return jsonResult({ success: true, taskId: "task-ref-1" });
      if (url.includes("/api/generate")) {
        return jsonResult({
          success: true,
          status: "ready",
          wavUrl: "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/ready.wav",
        });
      }
      if (url.includes("/api/user/balance")) return jsonResult({ balance: 2 });
      return jsonResult({ tracks: [] });
    });

    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    expect(screen.getByRole("button", { name: "+ Reference" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const bytes = new Uint8Array(44);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8);
    const file = new File([bytes], "Time Is Not My Friend.wav", { type: "audio/wav" });
    const input = document.getElementById("ref-audio-upload") as HTMLInputElement;
    expect(input).toHaveAttribute(
      "accept",
      "audio/wav,audio/mp3,audio/mpeg,audio/aac,audio/m4a,.wav,.mp3,.aac,.m4a",
    );
    expect(input.getAttribute("accept")).toContain("mpeg");
    expect(input.getAttribute("accept")).toContain("aac");
    const sourceRate = 48_000;
    const sourceFrames = 46 * sourceRate;
    const left = new Float32Array(sourceFrames);
    const right = new Float32Array(sourceFrames);
    left[0] = 0.5;
    right[0] = -0.5;
    FakeAudioContext.decoded = {
      numberOfChannels: 2,
      sampleRate: sourceRate,
      length: sourceFrames,
      duration: sourceFrames / sourceRate,
      getChannelData: (channel: number) => (channel === 0 ? left : right),
    };
    await user.upload(input, file);
    expect(screen.getByText("Selected: Time Is Not My Friend.wav")).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);
    expect(await screen.findByRole("button", { name: "Use Clip" })).toBeEnabled();
    expect(screen.getByRole("slider", { name: "Clip start" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByText("0:00–0:30")).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "Use Clip" }));

    expect(screen.queryByRole("dialog", { name: "Reference" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Analyzing reference...")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Remove reference" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Reference" })).not.toBeInTheDocument();
    const analyzingPill = screen.getByText("Analyzing reference...").parentElement as HTMLElement;
    expect(analyzingPill.className).toContain("flex");
    expect(analyzingPill.className).toContain("bg-red-950/50");
    expect(analyzingPill.className).toContain("border-red-500/60");
    expect(analyzingPill.querySelector(".animate-ping")).toBeTruthy();
    expect(analyzingPill.querySelector(".animate-pulse")).toBeNull();

    await waitFor(
      () =>
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(true),
      { timeout: 20_000 },
    );
    expect(FakeAudioContext.instances.length).toBeGreaterThan(0);
    expect(FakeAudioContext.instances[0]?.decodeAudioData).toHaveBeenCalled();
    expect(upload).toHaveBeenCalled();
    const [wavPath, wavBody, wavOptions] = upload.mock.calls[0] as [
      string,
      Blob,
      { contentType?: string; upsert?: boolean },
    ];
    expect(wavPath).toMatch(/^references\/user-1\/\d+-Time_Is_Not_My_Friend\.wav$/);
    expect(getPublicUrl).toHaveBeenCalledWith(wavPath);
    expect(wavOptions).toEqual({ contentType: "audio/wav", upsert: false });
    expect(wavBody).toBeInstanceOf(Blob);
    expect(wavBody).not.toBe(file);
    const duration = await expectReferencePcmWav(wavBody);
    expect(duration).toBeGreaterThan(29);
    expect(duration).toBeLessThanOrEqual(30);
    const analyzeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/reference/audio-to-prompt"),
    ) as [string, RequestInit];
    expect(analyzeCall[0]).toBe("/api/reference/audio-to-prompt");
    expect(analyzeCall[1].headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer session-token",
    });
    expect(analyzeCall[1].body).not.toBeInstanceOf(FormData);
    const posted = JSON.parse(String(analyzeCall[1].body)) as { audioUrl?: string; userId?: string };
    expect(posted).toEqual({
      audioUrl: `https://project.supabase.co/storage/v1/object/public/audio-vault/${wavPath}`,
    });
    expect(posted.audioUrl).toContain("/storage/v1/object/public/audio-vault/references/user-1/");
    expect(String(analyzeCall[1].body)).toBe(JSON.stringify({ audioUrl: posted.audioUrl }));
    expect(logSpy.mock.calls.some((args) => args[0] === "[AudioRef] Sliced Blob:" && args[2] === "audio/wav" && Number(args[1]) > 0)).toBe(
      true,
    );
    expect(
      logSpy.mock.calls.some(
        (args) => args[0] === "[AudioRef] sliced buffer" && Number(args[1]) > 29 && Number(args[1]) <= 30 && args[2] === 24_000,
      ),
    ).toBe(true);
    expect(logSpy.mock.calls.some((args) => args[0] === "[AudioRef]" && args[1] === posted.audioUrl)).toBe(true);
    expect(String(analyzeCall[1].body)).not.toContain(file.name);
    expect(String(analyzeCall[1].body)).not.toContain("RIFF");

    releaseAnalysis(jsonResult({ success: true, tags, filename: "Time Is Not My Friend.wav" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(tags));
    const pill = screen.getByRole("button", { name: "Remove reference" }).parentElement as HTMLElement;
    expect(pill).toHaveTextContent("Time Is Not My Friend.wav");
    expect(screen.queryByRole("button", { name: "Use Clip" })).not.toBeInTheDocument();
    expect(pill.querySelector(".animate-pulse")).toBeTruthy();
    expect(pill.querySelector(".animate-ping")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Lyrics" }), { target: { value: "hello line" } });
    expect(screen.getByRole("button", { name: "Remove reference" })).toBeInTheDocument();
    expect(pill).toHaveTextContent("Time Is Not My Friend.wav");
    expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(tags);

    await user.click(screen.getByRole("button", { name: "Render Master Record" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/generate")).toBe(true));
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/generate")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/generate"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/reference"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/vocals/upload"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("create-voice"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => /wavespeed\.ai|vocal-clone/i.test(String(url)))).toBe(false);

    const generateCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/generate") as [string, RequestInit];
    const generateBody = JSON.parse(String(generateCall[1].body)) as Record<string, unknown>;
    expect(generateBody.prompt).toBe(tags);
    expect(generateBody.stylePrompt).toBe(tags);
    expect(generateBody.lyrics).toBe("hello line");
    expect(generateBody.provider).toBe("wavespeed");
    expect(generateBody.model).toBe("mureka-9.5");
    expect(generateBody).not.toHaveProperty("isInstrumental");
    expect(generateBody).not.toHaveProperty("reference_audio_url");
    expect(generateBody).not.toHaveProperty("vocalId");
    expect(generateBody).not.toHaveProperty("vocal_id");
    expect(generateBody).not.toHaveProperty("userId");
    expect(screen.queryByText(/no wavUrl/i)).not.toBeInTheDocument();

    const calledUrls = fetchMock.mock.calls.map(([url]) => String(url));
    const analyzeAt = calledUrls.findIndex((url) => url.includes("/api/reference/audio-to-prompt"));
    const generateAt = calledUrls.findIndex((url) => url === "/api/generate");
    expect(analyzeAt).toBeGreaterThan(-1);
    expect(generateAt).toBeGreaterThan(analyzeAt);

    await user.click(screen.getByRole("button", { name: "Remove reference" }));
    expect(screen.getByRole("button", { name: "+ Reference" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(tags);
  },
    20_000,
  );

  it("decodes an MP3 reference and uploads a 16-bit wav instead of the original file", async () => {
    const user = userEvent.setup();
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/reference/audio-to-prompt")) {
        return jsonResult({ success: true, tags: "close vocal, dry" });
      }
      if (url.includes("/api/user/balance")) return jsonResult({ balance: 2 });
      return jsonResult({ tracks: [] });
    });

    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const mp3 = new File([new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00])], "clip.mp3", { type: "audio/mpeg" });
    const input = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(input, mp3);
    expect(upload).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);
    expect(await screen.findByRole("button", { name: "Use Clip" })).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    await confirmReferenceClip(user);

    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(FakeAudioContext.instances.length).toBeGreaterThan(0);
    expect(FakeAudioContext.instances[0]?.decodeAudioData).toHaveBeenCalled();
    const [path, body, options] = upload.mock.calls[0] as [string, Blob, { contentType?: string; upsert?: boolean }];
    expect(path).toMatch(/^references\/user-1\/\d+-clip\.wav$/);
    expect(options).toEqual({ contentType: "audio/wav", upsert: false });
    expect(body).not.toBe(mp3);
    await expectReferencePcmWav(body);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(true),
    );
    const analyzeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/reference/audio-to-prompt"),
    ) as [string, RequestInit];
    expect(analyzeCall[1].body).not.toBeInstanceOf(FormData);
    const posted = JSON.parse(String(analyzeCall[1].body)) as { audioUrl?: string };
    expect(posted).toEqual({
      audioUrl: `https://project.supabase.co/storage/v1/object/public/audio-vault/${path}`,
    });
    expect(posted.audioUrl).toContain("/storage/v1/object/public/audio-vault/references/user-1/");
  });

  it("keeps the reference file when analysis fails", async () => {
    const user = userEvent.setup();
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/reference/audio-to-prompt")) return jsonResult({ error: "Failed to analyze audio" }, 500);
      if (url.includes("/api/user/balance")) return jsonResult({ balance: 2 });
      return jsonResult({ tracks: [] });
    });

    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const bytes = new Uint8Array(44);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8);
    const input = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(input, new File([bytes], "Time Is Not My Friend.wav", { type: "audio/wav" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await confirmReferenceClip(user);

    await waitFor(() => expect(screen.getByText("Could not read that reference.")).toBeInTheDocument());
    expect(errorSpy).toHaveBeenCalledWith(
      "[AudioRef] API responded:",
      500,
      JSON.stringify({ error: "Failed to analyze audio" }),
    );
    expect(screen.getByRole("button", { name: "Remove reference" }).parentElement).toHaveTextContent(
      "Time Is Not My Friend.wav",
    );
    expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue("");
  });

  it("does not upload when reference decode fails", async () => {
    const user = userEvent.setup();
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    FakeAudioContext.failDecode = true;
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const bytes = new Uint8Array(44);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8);
    const input = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(input, new File([bytes], "broken.wav", { type: "audio/wav" }));

    await waitFor(() => expect(screen.getByText("Could not read that reference.")).toBeInTheDocument());
    expect(upload).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Use Clip" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);
  });

  it("does not upload when the sliced wav is empty or the channel read throws", async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    const encodeSpy = vi.spyOn(CharacterModalModule, "encodePcmWav").mockReturnValue(new Blob([], { type: "audio/wav" }));
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const bytes = new Uint8Array(44);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8);
    const input = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(input, new File([bytes], "empty.wav", { type: "audio/wav" }));
    await confirmReferenceClip(user);
    await waitFor(() => expect(screen.getByText("Could not read that reference.")).toBeInTheDocument());
    expect(upload).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);
    expect(errorSpy.mock.calls.some((args) => args[0] === "[AudioRef] refusing upload:" && args[1] === "byteLength is 0")).toBe(
      true,
    );
    encodeSpy.mockRestore();

    cleanup();
    errorSpy.mockClear();
    upload.mockClear();
    FakeAudioContext.decoded = {
      numberOfChannels: 1,
      sampleRate: 24_000,
      length: 24_000,
      duration: 1,
      copyFromChannel() {
        throw new Error("channel index exceeds number of channels");
      },
      getChannelData() {
        throw new Error("detached");
      },
    };
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const again = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(again, new File([bytes], "detached.wav", { type: "audio/wav" }));
    await confirmReferenceClip(user);
    await waitFor(() => expect(screen.getByText("Could not read that reference.")).toBeInTheDocument());
    expect(upload).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[AudioRef] gate failed: decode or slice returned null");
  });

  it("still uploads when copyFromChannel throws and channel data is readable", async () => {
    const user = userEvent.setup();
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/reference/audio-to-prompt")) return jsonResult({ success: true, tags: "mono clip" });
      if (url.includes("/api/user/balance")) return jsonResult({ balance: 2 });
      return jsonResult({ tracks: [] });
    });
    const samples = new Float32Array(24_000);
    samples[0] = 0.25;
    FakeAudioContext.decoded = {
      numberOfChannels: 1,
      sampleRate: 48_000,
      length: 48_000,
      duration: 1,
      copyFromChannel() {
        throw new Error("mono buffer has no channel 1");
      },
      getChannelData: (channel: number) => (channel === 0 ? samples : new Float32Array()),
    };
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const bytes = new Uint8Array(44);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8);
    const input = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(input, new File([bytes], "mono.wav", { type: "audio/wav" }));
    await confirmReferenceClip(user);
    await waitFor(() => expect(upload).toHaveBeenCalled());
    const body = upload.mock.calls[0]?.[1] as Blob;
    await expectReferencePcmWav(body);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(true);
  });

  it("logs a storage failure and does not call audio-to-prompt", async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storageError = { message: "new row violates row-level security policy", statusCode: "403" };
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    upload.mockResolvedValue({ error: storageError });
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const bytes = new Uint8Array(44);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8);
    const input = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(input, new File([bytes], "clip.wav", { type: "audio/wav" }));
    await confirmReferenceClip(user);
    await waitFor(() => expect(screen.getByText("Could not read that reference.")).toBeInTheDocument());
    expect(upload).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[AudioRef] Supabase upload failed:", storageError);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);
  });

  it("names the session and public URL gates and does not call audio-to-prompt", async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getSession.mockResolvedValue({ data: { session: null } });
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const bytes = new Uint8Array(44);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8);
    const input = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(input, new File([bytes], "clip.wav", { type: "audio/wav" }));
    await confirmReferenceClip(user);
    await waitFor(() => expect(screen.getByText("Could not read that reference.")).toBeInTheDocument());
    expect(upload).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[AudioRef] gate failed: no session / no user id");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);

    cleanup();
    errorSpy.mockClear();
    upload.mockClear();
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    getPublicUrl.mockImplementation(() => ({ data: { publicUrl: "" } }));
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const emptyUrl = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(emptyUrl, new File([bytes], "clip.wav", { type: "audio/wav" }));
    await confirmReferenceClip(user);
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("[AudioRef] gate failed: getPublicUrl empty"));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);

    cleanup();
    errorSpy.mockClear();
    getPublicUrl.mockImplementation(() => ({
      data: {
        publicUrl:
          "https://project.supabase.co/storage/v1/object/sign/audio-vault/references/user-1/clip.wav?token=fixture",
      },
    }));
    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const signed = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(signed, new File([bytes], "clip.wav", { type: "audio/wav" }));
    await confirmReferenceClip(user);
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith("[AudioRef] gate failed: publicReferenceAudioUrl", "signed url"),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);
    const logged = errorSpy.mock.calls.map((args) => args.map((part) => String(part)).join(" ")).join("\n");
    expect(logged).not.toContain("fixture");
    expect(logged).not.toContain("token=");
  });

  it("accepts the vite storage host and rejects token, localhost, and metadata URLs", async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });

    const wav = (name: string) => {
      const bytes = new Uint8Array(44);
      bytes.set([0x52, 0x49, 0x46, 0x46], 0);
      bytes.set([0x57, 0x41, 0x56, 0x45], 8);
      return new File([bytes], name, { type: "audio/wav" });
    };

    const openAndUse = async (name: string) => {
      render(<EnginePage />);
      await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
      await user.click(screen.getByRole("button", { name: "+ Reference" }));
      const input = document.getElementById("ref-audio-upload") as HTMLInputElement;
      await user.upload(input, wav(name));
      await confirmReferenceClip(user);
    };

    const expectRejected = async (reason: string) => {
      await waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith("[AudioRef] gate failed: publicReferenceAudioUrl", reason);
        expect(screen.getByText("Could not read that reference.")).toBeInTheDocument();
      });
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(false);
    };

    const loggedText = () =>
      [...errorSpy.mock.calls, ...logSpy.mock.calls].map((args) => args.map((part) => String(part)).join(" ")).join("\n");

    getPublicUrl.mockImplementation(() => ({
      data: {
        publicUrl:
          "https://project.supabase.co/storage/v1/object/public/audio-vault/references/user-1/clip.wav?token=fixture",
      },
    }));
    await openAndUse("token.wav");
    await expectRejected("token query");
    expect(loggedText()).not.toContain("fixture");
    expect(loggedText()).not.toContain("token=");

    cleanup();
    errorSpy.mockClear();
    logSpy.mockClear();
    fetchMock.mockClear();
    getPublicUrl.mockImplementation(() => ({
      data: {
        publicUrl: "https://localhost/storage/v1/object/public/audio-vault/references/user-1/clip.wav",
      },
    }));
    await openAndUse("local.wav");
    await expectRejected("blocked host");

    cleanup();
    errorSpy.mockClear();
    logSpy.mockClear();
    fetchMock.mockClear();
    getPublicUrl.mockImplementation(() => ({
      data: {
        publicUrl: "https://169.254.169.254/storage/v1/object/public/audio-vault/references/user-1/clip.wav",
      },
    }));
    await openAndUse("meta.wav");
    await expectRejected("blocked host");

    cleanup();
    errorSpy.mockClear();
    logSpy.mockClear();
    fetchMock.mockClear();
    getPublicUrl.mockImplementation(() => ({
      data: {
        publicUrl: "https://evil.example/storage/v1/object/public/audio-vault/references/user-1/clip.wav",
      },
    }));
    await openAndUse("evil.wav");
    await expectRejected("host");

    cleanup();
    errorSpy.mockClear();
    logSpy.mockClear();
    fetchMock.mockClear();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_URL", "");
    getPublicUrl.mockImplementation((path: string) => ({
      data: { publicUrl: `https://cdn.example/storage/v1/object/public/audio-vault/${path}` },
    }));
    await openAndUse("open.wav");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(true),
    );
    const openCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/reference/audio-to-prompt"),
    ) as [string, RequestInit];
    const openBody = JSON.parse(String(openCall[1].body)) as { audioUrl?: string };
    expect(openBody.audioUrl).toMatch(
      /^https:\/\/cdn\.example\/storage\/v1\/object\/public\/audio-vault\/references\/user-1\/\d+-open\.wav$/,
    );

    cleanup();
    errorSpy.mockClear();
    logSpy.mockClear();
    fetchMock.mockClear();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_URL", "https://vite-project.supabase.co");
    vi.stubEnv("SUPABASE_URL", "postgresql://postgres:db-secret@aws-0.pooler.supabase.com:6543/postgres");
    getPublicUrl.mockImplementation((path: string) => ({
      data: { publicUrl: `https://vite-project.supabase.co/storage/v1/object/public/audio-vault/${path}` },
    }));
    await openAndUse("vite.wav");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/reference/audio-to-prompt"))).toBe(true),
    );
    const viteCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/reference/audio-to-prompt"),
    ) as [string, RequestInit];
    const viteBody = JSON.parse(String(viteCall[1].body)) as { audioUrl?: string };
    expect(viteBody.audioUrl).toContain(
      "https://vite-project.supabase.co/storage/v1/object/public/audio-vault/references/user-1/",
    );
    expect(loggedText()).not.toContain("db-secret");
  }, 40_000);

  it("fills title, lyrics, and style from a visual injection and keeps them after remove", async () => {
    const user = userEvent.setup();
    const nextTitle = "Glass Harbor";
    const tags = "amber rock, 96 bpm, analog synth";
    const nextLyrics = "[Verse 1]\nhello line\n[Chorus]\nhold on";
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    let releaseVisual: (value: ReturnType<typeof jsonResult>) => void = () => {};
    const pendingVisual = new Promise<ReturnType<typeof jsonResult>>((resolve) => {
      releaseVisual = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/reference/visual-injection")) return pendingVisual;
      if (url.includes("/api/user/balance")) return jsonResult({ balance: 2 });
      return jsonResult({ tracks: [] });
    });

    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    expect(screen.getByRole("button", { name: "+ Visual Injection" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Remix" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ Visual Injection" }));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const input = document.getElementById("visual-injection-upload") as HTMLInputElement;
    expect(input).toHaveAttribute("accept", ".png,.jpg,.jpeg,.webp");
    await user.upload(input, new File([png], "cover.png", { type: "image/png" }));
    expect(screen.getByText("cover.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.getByText("Processing Visual...")).toBeInTheDocument());
    const reading = screen.getByText("Processing Visual...");
    expect(reading.className).toContain("font-mono");
    expect(reading.className).toContain("tracking-wide");
    expect(reading.className).toContain("font-medium");
    expect(reading.className).toContain("truncate");
    expect(reading.className).toContain("max-w-[130px]");
    expect(reading.parentElement?.className).toContain("bg-red-950/40");
    expect(reading.parentElement?.className).toContain("border-red-500/50");
    expect(reading.parentElement?.querySelector(".animate-ping")).toBeTruthy();
    expect(screen.queryByText("cover.png")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove visual reference" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Visual Injection" })).not.toBeInTheDocument();

    const visualCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/reference/visual-injection"),
    ) as [string, RequestInit];
    expect(visualCall[0]).toBe("/api/reference/visual-injection");
    expect(visualCall[1].headers).toEqual({ Authorization: "Bearer session-token" });
    expect(visualCall[1].body).toBeInstanceOf(FormData);
    expect(((visualCall[1].body as FormData).get("file") as File).name).toBe("cover.png");
    expect((visualCall[1].body as FormData).get("userId")).toBeNull();

    releaseVisual(jsonResult({ success: true, title: nextTitle, tags, lyrics: nextLyrics, filename: "cover.png" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Song title" })).toHaveValue(nextTitle));
    const injected = screen.getByText("Visual Injected");
    expect(injected.parentElement?.querySelector(".animate-pulse")).toBeTruthy();
    expect(screen.queryByText("cover.png")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(nextLyrics);
    expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(tags);

    await user.click(screen.getByRole("tab", { name: "With Vocals" }));
    expect(screen.getByRole("textbox", { name: "Song title" })).toHaveValue(nextTitle);
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(nextLyrics);
    expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(tags);

    await user.click(screen.getByRole("button", { name: "Remove visual reference" }));
    expect(screen.getByRole("button", { name: "+ Visual Injection" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Song title" })).toHaveValue(nextTitle);
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(nextLyrics);
    expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(tags);
  });

  it("appends audio tags after a visual fill and leaves title and lyrics", async () => {
    const user = userEvent.setup();
    const nextTitle = "Glass Harbor";
    const visualTags = "amber rock, 96 bpm";
    const nextLyrics = "[Verse 1]\nhello line";
    const acousticTags = "dry punchy drums, 120 bpm";
    const merged = `${visualTags}, ${acousticTags}`;
    let audioPasses = 0;
    let releaseSecond: (value: ReturnType<typeof jsonResult>) => void = () => {};
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/reference/visual-injection")) {
        return jsonResult({ success: true, title: nextTitle, tags: visualTags, lyrics: nextLyrics, filename: "cover.png" });
      }
      if (url.includes("/api/reference/audio-to-prompt")) {
        audioPasses += 1;
        if (audioPasses === 1) {
          return jsonResult({ success: true, tags: acousticTags, filename: "Time Is Not My Friend.wav" });
        }
        return new Promise<ReturnType<typeof jsonResult>>((resolve) => {
          releaseSecond = resolve;
        });
      }
      if (url.includes("/api/user/balance")) return jsonResult({ balance: 2 });
      return jsonResult({ tracks: [] });
    });

    render(<EnginePage />);
    await user.click(screen.getByRole("tab", { name: "Vocals with AI" }));
    await user.click(screen.getByRole("button", { name: "+ Visual Injection" }));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const visualInput = document.getElementById("visual-injection-upload") as HTMLInputElement;
    await user.upload(visualInput, new File([png], "cover.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Song title" })).toHaveValue(nextTitle));
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(nextLyrics);
    expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(visualTags);

    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const bytes = new Uint8Array(44);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8);
    const audioInput = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(audioInput, new File([bytes], "Time Is Not My Friend.wav", { type: "audio/wav" }));
    await confirmReferenceClip(user);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(merged));
    expect(screen.getByRole("textbox", { name: "Song title" })).toHaveValue(nextTitle);
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(nextLyrics);
    expect(screen.queryByText("Analyzing reference...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove reference" }).parentElement).toHaveTextContent(
      "Time Is Not My Friend.wav",
    );

    await user.click(screen.getByRole("button", { name: "Remove reference" }));
    await user.click(screen.getByRole("button", { name: "+ Reference" }));
    const again = document.getElementById("ref-audio-upload") as HTMLInputElement;
    await user.upload(again, new File([bytes], "Time Is Not My Friend.wav", { type: "audio/wav" }));
    await confirmReferenceClip(user);
    await waitFor(() => expect(screen.getByText("Analyzing reference...")).toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(merged);
    releaseSecond(jsonResult({ success: true, tags: acousticTags, filename: "Time Is Not My Friend.wav" }));
    await waitFor(() => expect(screen.queryByText("Analyzing reference...")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(merged);
    expect(screen.getByRole("textbox", { name: "Song title" })).toHaveValue(nextTitle);
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(nextLyrics);

    await user.click(screen.getByRole("tab", { name: "With Vocals" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue(merged));
    expect(screen.getByRole("textbox", { name: "Song title" })).toHaveValue(nextTitle);
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(nextLyrics);
  });
});

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static failDecode = false;
  static decoded: {
    numberOfChannels: number;
    sampleRate: number;
    length: number;
    duration: number;
    getChannelData: (channel: number) => Float32Array;
    copyFromChannel?: (destination: Float32Array, channelNumber: number, bufferOffset?: number) => void;
  } | null = null;
  state: AudioContextState = "running";
  decodeAudioData = vi.fn(async () => {
    if (FakeAudioContext.failDecode) throw new Error("decode failed");
    if (FakeAudioContext.decoded) return FakeAudioContext.decoded;
    return {
      numberOfChannels: 1,
      sampleRate: 44100,
      length: 4,
      duration: 4 / 44100,
      getChannelData: () => new Float32Array([0, 0.5, -0.5, 1]),
    };
  });
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
