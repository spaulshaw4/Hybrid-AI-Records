import { afterEach, describe, expect, it, vi } from "vitest";

const separateStems = vi.hoisted(() => vi.fn());
const convertVocalsWithStems = vi.hoisted(() => vi.fn());
const cloneVocalsFromSample = vi.hoisted(() => vi.fn());
const mixAndMasterHybridTrack = vi.hoisted(() => vi.fn());
const archiveGeneratedAudio = vi.hoisted(() => vi.fn(async (url: string) => url));

vi.mock("@/lib/stems.server", () => ({ separateStems }));
vi.mock("@/lib/fish-tts.server", () => ({ convertVocalsWithStems, cloneVocalsFromSample }));
vi.mock("@/lib/matchering-master.server", () => ({ mixAndMasterHybridTrack }));
vi.mock("@/lib/apiframe.server", () => ({ archiveGeneratedAudio }));

import {
  backingStemUrl,
  generationCompletesAfterMaster,
  parseDemucsOutput,
} from "@/lib/stem-urls";
import { buildVocalClonePayload } from "@/lib/vocal-clone-payload";
import { runHybridMasterPipeline } from "@/lib/hybrid-master-pipeline.server";

describe("Demucs stem mapping", () => {
  it("prefers no_vocals / accompaniment as the Matchering backing stem", () => {
    expect(
      parseDemucsOutput({
        vocals: "https://cdn.example/vocals.mp3",
        no_vocals: "https://cdn.example/backing.mp3",
        drums: "https://cdn.example/drums.mp3",
      }),
    ).toEqual({
      vocals: "https://cdn.example/vocals.mp3",
      drums: "https://cdn.example/drums.mp3",
      other: "https://cdn.example/backing.mp3",
    });
    expect(
      backingStemUrl({
        vocals: "https://cdn.example/vocals.mp3",
        drums: "https://cdn.example/drums.mp3",
        other: "https://cdn.example/backing.mp3",
      }),
    ).toBe("https://cdn.example/backing.mp3");
  });
});

describe("generation completion", () => {
  it("marks complete only after Matchering mixed a master URL", () => {
    expect(generationCompletesAfterMaster({ masterUrl: "https://cdn/master.mp3", mixed: true })).toBe(
      true,
    );
    expect(generationCompletesAfterMaster({ masterUrl: "https://cdn/raw.mp3", mixed: false })).toBe(
      false,
    );
    expect(generationCompletesAfterMaster({ masterUrl: null, mixed: true })).toBe(false);
  });
});

describe("Fish Audio vocal payload", () => {
  it("sends the isolated vocal and artist reference to native Fish TTS", () => {
    const isolated = new Uint8Array(512).fill(1);
    const reference = new Uint8Array(512).fill(2);
    const payload = buildVocalClonePayload({
      text: "hold the line",
      audio: isolated,
      extraReferences: [reference],
      format: "mp3",
    });
    expect(payload.references).toHaveLength(2);
    expect(payload.references?.[0]?.audio).toBe(isolated);
    expect(payload.references?.[0]?.text).toContain("hold the line");
    expect(payload.references?.[1]?.audio).toBe(reference);
    expect(payload.text).toBe("hold the line");
  });
});

/**
 * The vocal path must fail loudly. Mastering the untouched engine mix would
 * return a track that still carries the original vocal — indistinguishable
 * from success until the artist listens.
 */
const VOCAL_FAILURE = "Vocal conversion failed. Your hybrid tokens have not been charged.";
const VOCAL_TIMEOUT = "Vocal processing engine timed out. Please try your render again.";

/** Enough bytes to clear the pipeline's "downloaded audio was empty" guard. */
function audioResponse() {
  return new Response(new Uint8Array(2048), { status: 200 });
}

function baseInput(overrides: Partial<Parameters<typeof runHybridMasterPipeline>[0]> = {}) {
  return {
    baseAudioUrl: "https://cdn.example/base.mp3",
    lyrics: "[Chorus]\nHold the line",
    instrumental: false,
    title: "Night Drive",
    userId: "user-1",
    taskId: "task-1",
    ...overrides,
  };
}

describe("runHybridMasterPipeline vocal halting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("halts the render when stem isolation fails on a vocal track", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse()));
    separateStems.mockRejectedValue(new Error("Stem separation failed for this track."));

    await expect(runHybridMasterPipeline(baseInput())).rejects.toThrow(VOCAL_FAILURE);
    expect(mixAndMasterHybridTrack).not.toHaveBeenCalled();
  });

  it("halts the render when vocal conversion fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse()));
    separateStems.mockResolvedValue({
      vocals: "https://cdn.example/vocals.mp3",
      instrumental: "https://cdn.example/backing.mp3",
    });
    convertVocalsWithStems.mockRejectedValue(new Error("Voice cloning is unreachable."));

    await expect(runHybridMasterPipeline(baseInput())).rejects.toThrow(VOCAL_FAILURE);
    expect(mixAndMasterHybridTrack).not.toHaveBeenCalled();
  });

  it("reports a timeout distinctly so the copy can tell the artist to retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse()));
    separateStems.mockRejectedValue(new Error("Stem separation timed out for this track."));

    await expect(runHybridMasterPipeline(baseInput())).rejects.toThrow(VOCAL_TIMEOUT);
  });

  it("halts when conversion returns no usable audio instead of reusing the raw vocal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse()));
    separateStems.mockResolvedValue({
      vocals: "https://cdn.example/vocals.mp3",
      instrumental: "https://cdn.example/backing.mp3",
    });
    convertVocalsWithStems.mockResolvedValue({ tracks: [{ audioUrl: null }] });

    await expect(runHybridMasterPipeline(baseInput())).rejects.toThrow(VOCAL_FAILURE);
    expect(mixAndMasterHybridTrack).not.toHaveBeenCalled();
  });

  it("still masters an instrumental render when stem isolation fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse()));
    separateStems.mockRejectedValue(new Error("Stem separation failed for this track."));
    mixAndMasterHybridTrack.mockResolvedValue({
      masterUrl: "https://cdn.example/master.mp3",
      mixed: true,
      matched: true,
    });

    const result = await runHybridMasterPipeline(baseInput({ instrumental: true }));

    expect(result.masterUrl).toBe("https://cdn.example/master.mp3");
    expect(convertVocalsWithStems).not.toHaveBeenCalled();
  });
});
