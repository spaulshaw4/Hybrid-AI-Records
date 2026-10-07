import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, storageFrom, upload, getPublicUrl } = vi.hoisted(() => {
  const upload = vi.fn(async () => ({ data: { path: "ok" }, error: null }));
  const getPublicUrl = vi.fn((path: string) => ({
    data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/audio-vault/${path}` },
  }));
  return {
    getSession: vi.fn(),
    storageFrom: vi.fn(() => ({ upload, getPublicUrl })),
    upload,
    getPublicUrl,
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession },
    storage: { from: storageFrom },
  },
}));

import { VocalStudioTab } from "./VocalStudioTab";

function textResult(body: unknown, status = 200) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
    json: async () => (typeof body === "string" ? {} : body),
  };
}

describe("VocalStudioTab", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    cleanup();
    getSession.mockReset();
    storageFrom.mockClear();
    upload.mockReset();
    upload.mockResolvedValue({ data: { path: "ok" }, error: null });
    getPublicUrl.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a Style field, Claude assists, section pills, and the vocal upload", () => {
    render(<VocalStudioTab />);

    expect(screen.getByRole("textbox", { name: "Style" })).toBeInTheDocument();
    expect(screen.queryByText("Texture and mood")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "gritty" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "baritone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "close-mic" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "soulful" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude style assist" })).toHaveTextContent("Claude");
    expect(screen.getByRole("button", { name: "Claude lyrics assist" })).toHaveTextContent("Claude");
    for (const marker of ["[Verse]", "[Chorus]", "[Bridge]", "[Outro]"]) {
      expect(screen.getByRole("button", { name: marker })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Upload Vocal Audio / Reference")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "With Vocals" }).textContent).not.toMatch(
      /wavespeed|aimusic|sonic|mureka|replicate|fable/i,
    );
  });

  it("writes enhance_style into the Style field and keeps the draft when Claude fails", async () => {
    const user = userEvent.setup();
    render(<VocalStudioTab />);
    const style = screen.getByRole("textbox", { name: "Style" });
    await user.type(style, "rain");

    fetchMock.mockResolvedValueOnce(
      textResult({ error: "Style enhancement returned an empty prompt." }, 500),
    );
    await user.click(screen.getByRole("button", { name: "Claude style assist" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Style enhancement returned an empty prompt.");
    expect(style).toHaveValue("rain");

    fetchMock.mockResolvedValueOnce(
      textResult({ success: true, style: "warm close vocal, 92 BPM", prompt: "warm close vocal, 92 BPM" }),
    );
    await user.click(screen.getByRole("button", { name: "Claude style assist" }));
    await waitFor(() => expect(style).toHaveValue("warm close vocal, 92 BPM"));

    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/ai/coproducer");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "enhance_style",
      prompt: "rain",
      lyrics: "",
    });
    expect(init.headers).toMatchObject({ Authorization: "Bearer session-token" });
  });

  it("calls generate_lyrics for a topic and format_lyrics for a draft without clearing on failure", async () => {
    const user = userEvent.setup();
    render(<VocalStudioTab />);
    const style = screen.getByRole("textbox", { name: "Style" });
    const lyrics = screen.getByRole("textbox", { name: "Lyrics" });
    await user.type(style, "storm");

    fetchMock.mockResolvedValueOnce(
      textResult({
        lyrics: "[Verse]\nline\n[Chorus]\nwe\n[Bridge]\nstay\n[Outro]\ngo",
        result: "[Verse]\nline\n[Chorus]\nwe\n[Bridge]\nstay\n[Outro]\ngo",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Claude lyrics assist" }));
    await waitFor(() =>
      expect(lyrics).toHaveValue("[Verse]\nline\n[Chorus]\nwe\n[Bridge]\nstay\n[Outro]\ngo"),
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      action: "generate_lyrics",
      topic: "storm",
      genre: "storm",
    });

    await user.clear(lyrics);
    await user.type(lyrics, "keep me");
    fetchMock.mockResolvedValueOnce(textResult("not-json", 500));
    await user.click(screen.getByRole("button", { name: "Claude lyrics assist" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/non-JSON/);
    expect(lyrics).toHaveValue("keep me");

    fetchMock.mockResolvedValueOnce(textResult({ lyrics: "[Verse]\nkeep me\n[Outro]\ngo", result: "ok" }));
    await user.click(screen.getByRole("button", { name: "Claude lyrics assist" }));
    await waitFor(() => expect(lyrics).toHaveValue("[Verse]\nkeep me\n[Outro]\ngo"));
    const formatBody = JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body)) as {
      action: string;
      lyrics: string;
      genre: string;
    };
    expect(formatBody).toEqual({
      action: "format_lyrics",
      lyrics: "keep me",
      genre: "storm",
    });
  });

  it("inserts a section marker from the lyric pills", async () => {
    const user = userEvent.setup();
    render(<VocalStudioTab />);
    await user.click(screen.getByRole("button", { name: "[Verse]" }));
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue("[Verse]\n");
  });

  it("rejects other file types and uploads wav or mp3 to audio-vault", async () => {
    const user = userEvent.setup();
    render(<VocalStudioTab />);
    const input = screen.getByLabelText("Upload Vocal Audio / Reference");
    const choose = (file: File) => {
      fireEvent.change(input, { target: { files: [file] } });
    };

    choose(new File(["notes"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload a .wav or .mp3 file.");
    expect(upload).not.toHaveBeenCalled();

    choose(new File(["RIFF"], "take.wav", { type: "audio/wav" }));
    expect(await screen.findByText("take.wav")).toBeInTheDocument();
    const [wavPath, , wavOptions] = upload.mock.calls[0] as [string, File, { contentType: string; upsert: boolean }];
    expect(wavPath).toMatch(
      /^vocal-references\/user-1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/,
    );
    expect(wavOptions).toEqual({ contentType: "audio/wav", upsert: false });
    expect(storageFrom).toHaveBeenCalledWith("audio-vault");

    choose(new File(["ID3"], "hook.mp3", { type: "audio/mpeg" }));
    expect(await screen.findByText("hook.mp3")).toBeInTheDocument();
    const [mp3Path, , mp3Options] = upload.mock.calls[1] as [string, File, { contentType: string }];
    expect(mp3Path).toMatch(/\.mp3$/);
    expect(mp3Options.contentType).toBe("audio/mpeg");

    const publicUrl = `https://project.supabase.co/storage/v1/object/public/audio-vault/${mp3Path}`;
    await user.type(screen.getByRole("textbox", { name: "Lyrics" }), "hello line");
    await user.type(screen.getByRole("textbox", { name: "Style" }), "dry vocal");
    fetchMock.mockResolvedValueOnce(textResult({ success: true, taskId: "task-vocal-1" }));
    await user.click(screen.getByRole("button", { name: "Render vocal" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/vocals/generate");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "",
      lyrics: "hello line",
      vocalGender: "Male Vocal",
      styleTags: "dry vocal",
      vocalAudioUrl: publicUrl,
    });
  });
});
