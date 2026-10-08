import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MUREKA_TEMPLATES } from "@/data/murekaTemplates";

const { getSession } = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession },
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
    localStorage.clear();
    getSession.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockResolvedValue({
      data: { session: { user: { id: "user-1" }, access_token: "session-token" } },
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("matches the shared studio order, ghostwriter, gender, track length, and Render Master Record", () => {
    render(<VocalStudioTab />);

    const title = screen.getByRole("textbox", { name: "Song title" });
    const lyrics = screen.getByRole("textbox", { name: "Lyrics" });
    const style = screen.getByRole("textbox", { name: "Style" });
    const gender = screen.getByRole("group", { name: "Vocal gender" });
    const length = screen.getByLabelText("Track Length");
    const submit = screen.getByRole("button", { name: "Render Master Record" });
    expect(title).toHaveAttribute("placeholder", "Enter song title");
    expect(title.compareDocumentPosition(lyrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lyrics.compareDocumentPosition(style) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(style.compareDocumentPosition(gender) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(gender.compareDocumentPosition(length) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(length.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByText("Lyrics & Structure")).toBeInTheDocument();
    expect(screen.getByText("Musical Style")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Surprise Me" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Templates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saved" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear style" })).toBeInTheDocument();
    const ghostwriter = screen.getByRole("button", { name: "Studio Ghostwriter" });
    expect(ghostwriter.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Male", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Female", pressed: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /claude/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Render Track" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /render vocal/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Upload Vocal Audio / Reference")).not.toBeInTheDocument();
    expect(length).toBeInTheDocument();
    expect(screen.getByLabelText("Track Length (Seconds)")).toHaveValue(180);
    expect(screen.getByRole("button", { name: "3 min", pressed: true })).toBeInTheDocument();
    for (const marker of ["[Verse]", "[Chorus]", "[Bridge]", "[Outro]"]) {
      expect(screen.queryByRole("button", { name: marker })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("form", { name: "With Vocals" }).textContent).not.toMatch(
      /claude|wavespeed|aimusic|sonic|mureka|replicate|fable/i,
    );
  });

  it("writes enhance_style into the Style field and keeps the draft when assist fails", async () => {
    const user = userEvent.setup();
    render(<VocalStudioTab />);
    const style = screen.getByRole("textbox", { name: "Style" });
    await user.type(style, "rain");

    fetchMock.mockResolvedValueOnce(
      textResult({ error: "Style enhancement returned an empty prompt." }, 500),
    );
    await user.click(screen.getByRole("button", { name: "Expand Style" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Style enhancement returned an empty prompt.");
    expect(style).toHaveValue("rain");

    fetchMock.mockResolvedValueOnce(
      textResult({ success: true, style: "warm close vocal, 92 BPM", prompt: "warm close vocal, 92 BPM" }),
    );
    await user.click(screen.getByRole("button", { name: "Expand Style" }));
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

  it("calls enhance_style for Surprise Me when the style box is empty", async () => {
    const user = userEvent.setup();
    render(<VocalStudioTab />);
    fetchMock.mockResolvedValueOnce(textResult({ style: "lo-fi keys", prompt: "lo-fi keys" }));
    await user.click(screen.getByRole("button", { name: "Surprise Me" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Style" })).toHaveValue("lo-fi keys"));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      action: "enhance_style",
      prompt: "",
      lyrics: "",
    });
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
    await user.click(screen.getByRole("button", { name: "Studio Ghostwriter" }));
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
    await user.click(screen.getByRole("button", { name: "Format & Polish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/non-JSON/);
    expect(lyrics).toHaveValue("keep me");

    fetchMock.mockResolvedValueOnce(textResult({ lyrics: "[Verse]\nkeep me\n[Outro]\ngo", result: "ok" }));
    await user.click(screen.getByRole("button", { name: "Format & Polish" }));
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

  it("does not render lyric section pills", () => {
    render(<VocalStudioTab />);
    expect(screen.getByText("Lyrics & Structure")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Lyric sections" })).not.toBeInTheDocument();
    for (const marker of ["[Verse]", "[Chorus]", "[Bridge]", "[Outro]"]) {
      expect(screen.queryByRole("button", { name: marker })).not.toBeInTheDocument();
    }
  });

  it("clears the style box from the trash control", async () => {
    const user = userEvent.setup();
    render(<VocalStudioTab />);
    const style = screen.getByRole("textbox", { name: "Style" });
    await user.type(style, "rain");
    await user.click(screen.getByRole("button", { name: "Clear style" }));
    expect(style).toHaveValue("");
    expect(screen.getByRole("button", { name: "Surprise Me" })).toBeInTheDocument();
  });

  it("loads a template and a saved prompt into the style box", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      "hybrid_prompt_records",
      JSON.stringify([
        {
          id: "saved-1",
          title: "Night",
          prompt: "warm rain",
          timestamp: Date.now(),
          isBookmarked: true,
        },
      ]),
    );
    render(<VocalStudioTab />);
    const style = screen.getByRole("textbox", { name: "Style" });

    await user.click(screen.getByRole("button", { name: "Templates" }));
    const useTemplate = screen.getAllByRole("button", { name: "Use template" })[0];
    expect(useTemplate).toBeTruthy();
    await user.click(useTemplate!);
    expect(style).toHaveValue(MUREKA_TEMPLATES[0]!.prompt);

    await user.click(screen.getByRole("button", { name: "Saved" }));
    await user.click(screen.getByRole("button", { name: /Night/ }));
    expect(style).toHaveValue("warm rain");
  });

  it("sends duration, persona id, and an audio-vault reference on Render Master Record", async () => {
    const user = userEvent.setup();
    const reference = "https://project.supabase.co/storage/v1/object/public/audio-vault/vocal-references/user-1/take.wav";
    render(
      <VocalStudioTab
        reference={{
          label: "My Voice - October 5",
          personaId: "vocal_stephen_oct5_master",
          vocalAudioUrl: reference,
        }}
      />,
    );
    expect(screen.getByText("My Voice - October 5")).toBeInTheDocument();
    expect(screen.getByLabelText("Track Length (Seconds)")).toHaveValue(180);

    await user.type(screen.getByRole("textbox", { name: "Lyrics" }), "hello line");
    await user.type(screen.getByRole("textbox", { name: "Style" }), "dry vocal");
    await user.click(screen.getByRole("button", { name: "30 sec" }));
    fetchMock.mockResolvedValueOnce(textResult({ success: true, taskId: "task-vocal-1" }));
    await user.click(screen.getByRole("button", { name: "Render Master Record" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/vocals/generate");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "",
      lyrics: "hello line",
      vocalGender: "Male Vocal",
      styleTags: "dry vocal",
      duration: 30,
      vocalAudioUrl: reference,
      personaId: "vocal_stephen_oct5_master",
    });
  });
});
