// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionFromCreateResponse } from "@/lib/create-session-id";
import {
  AUTOTUNE_MODEL_ID,
  AUTOTUNE_VERSION_ID,
  LYRIA_MODEL_ID,
  MINIMAX_MODEL_ID,
  MINIMAX_VERSION_ID,
  handleTrackCreate,
  localMasterResponse,
  resetTrackCreateForTests,
  trackStatusResponse,
} from "@/lib/track-create.server";
import { mapKeyToAutotuneScale } from "@/lib/voice-synchronizer.server";

const AUTOTUNE_VERSION_HASH = "53d58aea27ccd949e5f9d77e4b2a74ffe90e1fa534295b257cea50f011e233dd";
const GUIDE_URL = "https://replicate.delivery/pb/guide.wav";
const TUNED_URL = "https://replicate.delivery/pb/tuned.wav";
const MASTER_URL = "https://replicate.delivery/pb/master.wav";

function audioBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy]);
}
const RVC_LOOKUP_URL = "https://api.replicate.com/v1/models/cjwbw/rvc";
const RVC_VERSION = "test-rvc-version-from-schema";
const STYLE_PROMPT = "Acoustic, Heavy Rock";
const USER_LYRICS = "neon rain";

const syncState = vi.hoisted(() => ({
  calls: [] as Array<{ inputPath: string; outputPath: string; bpm: number; key?: string }>,
}));

vi.mock("@/lib/voice-synchronizer.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice-synchronizer.server")>();
  return {
    ...actual,
    synchronizeVocal: async (options: { inputPath: string; outputPath: string; bpm: number; key?: string }) => {
      const { copyFile } = await import("node:fs/promises");
      syncState.calls.push(options);
      await copyFile(options.inputPath, options.outputPath);
      const promptMetadata = `[Tempo: ${options.bpm} BPM]${options.key ? ` [Key: ${options.key}]` : ""} [Meter: 4/4] [Vocal Length: 4 bars]`;
      return {
        synchronizedAudioPath: options.outputPath,
        durationSeconds: 8,
        totalBars: 4,
        promptMetadata,
      };
    },
  };
});

function guidePrompt(prompt: string, bpm = 86): string {
  return `${prompt}, ${bpm} BPM, studio production`;
}

function zipOnlySchema() {
  return {
    latest_version: {
      id: RVC_VERSION,
      openapi_schema: {
        components: {
          schemas: {
            Input: {
              properties: {
                input_audio: { type: "string", description: "Upload your audio file here." },
                custom_rvc_model_download_url: {
                  type: "string",
                  description: "URL to download a custom RVC model zip containing .pth weights.",
                },
                pitch_change: { type: "number", description: "Adjust pitch in semitones." },
                index_rate: { type: "number" },
                protect: { type: "number" },
              },
            },
          },
        },
      },
    },
  };
}

function referenceAudioSchema() {
  return {
    latest_version: {
      id: RVC_VERSION,
      openapi_schema: {
        components: {
          schemas: {
            Input: {
              properties: {
                input_audio: { type: "string", description: "Upload your audio file here." },
                reference_audio: {
                  type: "string",
                  description: "Reference audio recording of the target voice.",
                },
                custom_rvc_model_download_url: {
                  type: "string",
                  description: "URL to download a custom RVC model zip containing .pth weights.",
                },
                pitch_change: { type: "number" },
                index_rate: { type: "number" },
                protect: { type: "number" },
              },
            },
          },
        },
      },
    },
  };
}

const ffmpegSpawns: string[][] = [];
const ffmpegHooks = vi.hoisted(() => ({
  spawn: null as null | ((command: string, args: readonly string[]) => EventEmitter),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn(command: string, args?: readonly string[], options?: unknown) {
      if (command === "ffmpeg" || command.toLowerCase().endsWith("ffmpeg.exe")) {
        ffmpegSpawns.push([command, ...(args ?? [])]);
        if (ffmpegHooks.spawn) return ffmpegHooks.spawn(command, args ?? []);
        const stderr = new EventEmitter();
        const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        child.stderr = stderr;
        process.nextTick(() => child.emit("error", new Error("ffmpeg should not run")));
        return child;
      }
      return actual.spawn(command, args as string[], options as never);
    },
  };
});

const PROMPT = "A bright analog house groove with a soft vocal hook and roomy drums tonight.";

const originalFetch = globalThis.fetch;
const originalToken = process.env.REPLICATE_API_TOKEN;

afterEach(() => {
  syncState.calls.length = 0;
  ffmpegSpawns.length = 0;
  ffmpegHooks.spawn = null;
  globalThis.fetch = originalFetch;
  resetTrackCreateForTests();
  if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
  else process.env.REPLICATE_API_TOKEN = originalToken;
});

function jsonRequest(body: unknown): Request {
  return new Request("http://127.0.0.1:3000/api/tracks/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function vocalFile(): File {
  return new File([new Uint8Array(128)], "ref_vocal.wav", { type: "audio/wav" });
}

describe("POST /api/tracks/create on port 3000", () => {
  it("maps musical keys onto nateraw/autotune scales", () => {
    expect(AUTOTUNE_MODEL_ID).toBe("nateraw/autotune");
    expect(AUTOTUNE_VERSION_ID).toBe(AUTOTUNE_VERSION_HASH);
    expect(mapKeyToAutotuneScale("E Major")).toBe("E:maj");
    expect(mapKeyToAutotuneScale("A Minor")).toBe("A:min");
    expect(mapKeyToAutotuneScale("")).toBe("closest");
  });

  it("returns 200 pending JSON before any Replicate HTTP call", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token-not-live";
    const calls: string[] = [];
    let allowModel = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!allowModel) {
        throw new Error(`Replicate was called before the create response: ${url}`);
      }
      calls.push(url);
      return new Response(JSON.stringify({ id: "pred_test", status: "failed", error: "mocked" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let blocked: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      handleTrackCreate(jsonRequest({ prompt: PROMPT })),
      new Promise<Response>((_, reject) => {
        blocked = setTimeout(
          () => reject(new Error("create handler blocked before returning pending JSON")),
          500,
        );
      }),
    ]);
    if (blocked) clearTimeout(blocked);

    expect(calls).toEqual([]);
    expect(response.status).toBe(200);
    allowModel = true;
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: true,
      status: "pending",
      session_id: body.session_id,
      sessionId: body.session_id,
      track_id: body.session_id,
      id: body.session_id,
      token_cost: 1,
      vocal_present: false,
    });
    expect(body.master_url).toBeUndefined();
    expect(String(body.session_id)).toMatch(/^ht_[0-9a-f]{12}$/);
    expect(sessionFromCreateResponse(response, body)).toBe(body.session_id);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.some((url) => url.includes(`/models/${LYRIA_MODEL_ID}/predictions`))).toBe(true);
    expect(calls.some((url) => url.includes("music-01"))).toBe(false);
    expect(calls.some((url) => url.includes(MINIMAX_MODEL_ID))).toBe(false);
    expect(calls.some((url) => url.includes(MINIMAX_VERSION_ID))).toBe(false);
    expect(calls.some((url) => url.includes("8880"))).toBe(false);
    expect(ffmpegSpawns).toEqual([]);
    expect(syncState.calls).toEqual([]);
  });

  it("returns pending JSON with zero Replicate calls, then one continuation request", async () => {
    const job = await runVocalJob(styleVocalRequest(), { failPrediction: true });
    expect(job.callsBeforeResponse).toEqual([]);
    expect(job.created).toEqual({
      success: true,
      status: "pending",
      session_id: job.sessionId,
      sessionId: job.sessionId,
      track_id: job.sessionId,
      id: job.sessionId,
      token_cost: 1,
      vocal_present: true,
    });
    expect(job.sessionId).toMatch(/^ht_[0-9a-f]{12}$/);
    const predictions = job.calls.filter((call) => call.url.includes("/predictions"));
    expect(predictions).toHaveLength(2);
    expect(predictions.every((call) => call.url === "https://api.replicate.com/v1/predictions")).toBe(true);
    expect(predictions.some((call) => call.url.includes("music-01"))).toBe(false);
    expect(predictions.some((call) => call.url.includes(LYRIA_MODEL_ID))).toBe(false);
    const autotunePayload = JSON.parse(
      predictions.find((call) => call.body.includes(AUTOTUNE_VERSION_ID))?.body || "{}",
    ) as { version?: string; input: Record<string, unknown> };
    expect(autotunePayload.version).toBe(AUTOTUNE_VERSION_HASH);
    expect(autotunePayload.input).toEqual({
      audio_file: "https://api.replicate.com/v1/files/ref_vocal_synced.wav",
      scale: "E:maj",
      output_format: "wav",
    });
    const payload = JSON.parse(
      predictions.find((call) => call.body.includes(MINIMAX_VERSION_ID))?.body || "{}",
    ) as {
      version?: string;
      input: Record<string, unknown>;
    };
    expect(payload.version).toBe(MINIMAX_VERSION_ID);
    expect(payload.input).toEqual({
      prompt: guidePrompt(STYLE_PROMPT, 86),
      lyrics: USER_LYRICS,
      lyrics_optimizer: false,
      is_instrumental: false,
      audio_format: "wav",
      sample_rate: 44100,
      bitrate: 256000,
    });
    expect(String(payload.input.prompt)).toContain(STYLE_PROMPT);
    expect(String(payload.input.prompt)).not.toContain("instrumental");
    expect(String(payload.input.prompt)).not.toContain("[Tempo:");
    expect(String(payload.input.prompt)).not.toContain("[Key:");
    expect(String(payload.input.prompt)).not.toMatch(/upbeat pop/i);
    expect(String(payload.input.prompt)).not.toMatch(/pristine mix/i);
    expect(payload.input.lyrics).not.toContain("[Tempo:");
    expect(payload.input.lyrics).not.toContain("E:maj");
    expect(payload.input.lyrics).not.toContain(autotunePayload.input.scale);
    expect(payload.input.lyrics).not.toBe(payload.input.prompt);
    expect(payload.input).not.toHaveProperty("voice_file");
    expect(syncState.calls).toHaveLength(1);
    expect(syncState.calls[0]?.bpm).toBe(86);
    expect(syncState.calls[0]?.key).toBe("E Major");
    expect(syncState.calls[0]?.inputPath.replace(/\\/g, "/")).toMatch(/\/vocal_dna\.wav$/);
    expect(syncState.calls[0]?.outputPath.replace(/\\/g, "/")).toMatch(/\/ref_vocal_synced\.wav$/);
    expect(job.uploadedNames).toEqual(["ref_vocal_synced.wav"]);
    expect(job.calls.some((call) => call.url.includes("/files"))).toBe(true);
    expect(job.calls.some((call) => call.url.includes("music-01"))).toBe(false);
    expect(job.calls.some((call) => call.url.includes(LYRIA_MODEL_ID))).toBe(false);
    expect(ffmpegSpawns.flat().join(" ")).not.toMatch(/amix/i);
    expect(ffmpegSpawns).toEqual([]);
  });

  it("rejects an empty prompt instead of borrowing the title or style", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token-not-live";
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("Replicate was called for an empty prompt");
    }) as typeof fetch;

    const form = new FormData();
    form.append("prompt", "   ");
    form.append("style", STYLE_PROMPT);
    form.append("title", "Upbeat Pop");
    form.append("genre", "pop");
    form.append("vocal_file", vocalFile(), "ref_vocal.wav");
    const response = await handleTrackCreate(
      new Request("http://127.0.0.1:3000/api/tracks/create", { method: "POST", body: form }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: "Prompt is required and cannot be empty." });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([]);
    expect(ffmpegSpawns).toEqual([]);
  });

  it("forwards pop and upbeat pop when that is the prompt", async () => {
    const pop = await runVocalJob(vocalForm({ prompt: "pop", genre: STYLE_PROMPT, field: "voice_sample" }));
    const popBody = continuationInput(pop.calls);
    expect(popBody.prompt).toBe(guidePrompt("pop", 86));
    expect(popBody.prompt).not.toContain(STYLE_PROMPT);
    expect(popBody.prompt).not.toContain("instrumental");
    expect(popBody.prompt).not.toContain("[Tempo:");
    expect(popBody.prompt).not.toContain("[Key:");
    expect(popBody.input.lyrics).toBe("");
    expect(popBody.input.lyrics).not.toContain("[Tempo:");
    expect(popBody.input.is_instrumental).toBe(false);
    expect(popBody.input).not.toHaveProperty("voice_file");

    const typed = await runVocalJob(vocalForm({ prompt: "upbeat pop", style: "upbeat pop" }));
    const typedBody = continuationInput(typed.calls);
    expect(typedBody.prompt).toBe(guidePrompt("upbeat pop", 86));
    expect(typedBody.prompt).not.toContain(STYLE_PROMPT);
    expect(typedBody.prompt).not.toContain("[Tempo:");
    expect(typedBody.prompt).not.toContain("[Key:");
    expect(ffmpegSpawns).toEqual([]);
  });

  it("fails a vocal job when the take is missing and does not switch engines", async () => {
    const form = new FormData();
    form.append("prompt", STYLE_PROMPT);
    form.append("vocal_present", "true");
    form.append("bpm", "86");
    const job = await runVocalJob(
      new Request("http://127.0.0.1:3000/api/tracks/create", { method: "POST", body: form }),
    );
    expect(job.created.vocal_present).toBe(true);
    expect(job.calls).toEqual([]);
    expect(job.payload.status).toBe("failed");
    expect(job.payload.error).toBe("Voice API failed: vocal_dna.wav is missing");
    expect(syncState.calls).toEqual([]);
    expect(job.payload.master_url).toBeNull();
    expect(ffmpegSpawns).toEqual([]);
  });

  it("does not fall back to Lyria or ffmpeg when continuation returns 404", async () => {
    const job = await runVocalJob(styleVocalRequest(), { predictionStatus: 404 });
    expect(job.payload.status).toBe("failed");
    expect(job.payload.error).toBe("Voice API failed: HTTP 404");
    expect(job.payload.master_url).toBeNull();
    expect(job.calls.some((call) => call.url.includes(LYRIA_MODEL_ID))).toBe(false);
    expect(job.calls.some((call) => call.url.includes("music-01"))).toBe(false);
    expect(job.calls.filter((call) => call.body.includes(MINIMAX_VERSION_ID))).toHaveLength(1);
    expect(job.calls.filter((call) => call.body.includes(AUTOTUNE_VERSION_ID))).toHaveLength(1);
    expect(JSON.parse(job.calls.find((call) => call.body.includes(MINIMAX_VERSION_ID))?.body || "{}").version).toBe(
      MINIMAX_VERSION_ID,
    );
    expect(ffmpegSpawns).toEqual([]);
  });

  it("keeps an empty or unwired guide from becoming the master", async () => {
    const empty = await runVocalJob(styleVocalRequest(), { guideBytes: new Uint8Array(0) });
    expect(empty.payload.status).toBe("failed");
    expect(empty.payload.error).toBe("Voice API failed: guide wav is missing");
    expect(empty.payload.master_url).toBeNull();
    expect(empty.calls.some((call) => call.url.includes("music-01"))).toBe(false);
    expect(ffmpegSpawns).toEqual([]);

    const lookupFailed = await runVocalJob(styleVocalRequest(), {}, async (sessionId) => {
      const names = await readdir(path.join(process.env.HYBRID_TRACK_SCRATCH || "", sessionId));
      expect(names).toContain("vocal_dna.wav");
      expect(names).toContain("ref_vocal_raw.wav");
      expect(names).toContain("ref_vocal_synced.wav");
      expect(names).toContain("guide_raw.wav");
      expect(names).toContain("vocal_dna_tuned.wav");
      expect(names.some((name) => name.endsWith("_master.wav"))).toBe(false);
    });
    expect(lookupFailed.payload.status).toBe("failed");
    expect(lookupFailed.payload.master_url).toBeNull();
    expect(lookupFailed.payload.error).toBe(
      "Voice API failed: Voice conversion model lookup failed: HTTP 404 Model not found.",
    );
    expect(lookupFailed.calls.some((call) => call.url.includes("music-01"))).toBe(false);
    expect(lookupFailed.calls.filter((call) => call.body.includes(MINIMAX_VERSION_ID))).toHaveLength(1);
    expect(lookupFailed.calls.filter((call) => call.body.includes(AUTOTUNE_VERSION_ID))).toHaveLength(1);
    const guide = continuationInput(lookupFailed.calls);
    expect(guide.prompt).toContain(STYLE_PROMPT);
    expect(guide.prompt).not.toContain("instrumental");
    expect(guide.input.is_instrumental).toBe(false);
    expect(guide.input.lyrics).toBe(USER_LYRICS);
    expect(String(guide.input.lyrics)).not.toContain("[Tempo:");

    const zip = await runVocalJob(styleVocalRequest(), { rvc: "zip" });
    expect(zip.payload.status).toBe("failed");
    expect(zip.payload.error).toBe("Voice conversion model cannot accept a wav enrollment");
    expect(zip.payload.master_url).toBeNull();
    expect(zip.calls.filter((call) => call.body.includes(MINIMAX_VERSION_ID))).toHaveLength(1);
    expect(zip.calls.filter((call) => call.body.includes(AUTOTUNE_VERSION_ID))).toHaveLength(1);
    expect(zip.calls.filter((call) => call.body.includes(RVC_VERSION))).toHaveLength(0);
    expect(zip.calls.some((call) => call.body.includes("custom_rvc_model_download_url"))).toBe(false);
    expect(zip.calls.some((call) => call.url.includes("music-01"))).toBe(false);
    expect(ffmpegSpawns).toEqual([]);
  });

  it("morphs timbre when the schema has a wav reference field and does not sing tempo metadata", async () => {
    const written = await runVocalJob(
      styleVocalRequest("Take One"),
      { rvc: "reference", masterBytes: Uint8Array.from([1, 2, 3, 4]) },
      async (sessionId) => {
        const names = await readdir(path.join(process.env.HYBRID_TRACK_SCRATCH || "", sessionId));
        expect(names).toContain("vocal_dna.wav");
        expect(names).toContain("ref_vocal_synced.wav");
        expect(names).toContain("guide_raw.wav");
        expect(names).toContain("vocal_dna_tuned.wav");
        const tuned = await stat(path.join(process.env.HYBRID_TRACK_SCRATCH || "", sessionId, "vocal_dna_tuned.wav"));
        expect(tuned.size).toBeGreaterThan(0);
        expect(names).not.toContain("ref_vocal.wav");
        expect(names).not.toContain("bed_instrumental.wav");
        expect(names).toContain(`${sessionId}_master.wav`);
        const master = await localMasterResponse(`${sessionId}_master.wav`);
        expect(master?.headers.get("Content-Type")).toBe("audio/wav");
        expect(master?.headers.get("Content-Disposition")).toBe('attachment; filename="Take One.wav"');
      },
    );
    expect(written.payload.status).toBe("completed");
    expect(written.payload.error).toBeNull();
    expect(written.payload.master_url).toBe(`/api/stream/${written.sessionId}_master.wav`);
    expect(written.calls.some((call) => call.url.includes("music-01"))).toBe(false);
    const payload = continuationInput(written.calls);
    expect(payload.prompt).toContain(STYLE_PROMPT);
    expect(payload.input.is_instrumental).toBe(false);
    expect(payload.input.lyrics).not.toContain("[Tempo:");
    const rvcCall = written.calls.find((call) => call.body.includes(RVC_VERSION));
    expect(rvcCall?.body ?? "").not.toContain("[Tempo:");
    const rvcPayload = JSON.parse(rvcCall?.body || "{}") as { input?: Record<string, unknown> };
    expect(rvcPayload.input).toMatchObject({
      pitch_change: 0,
      index_rate: 0.75,
      protect: 0.33,
    });
    expect(String(rvcPayload.input?.input_audio)).toMatch(/^https:\/\//);
    expect(String(rvcPayload.input?.reference_audio)).toContain("vocal_dna_tuned.wav");
    expect(rvcPayload.input).not.toHaveProperty("custom_rvc_model_download_url");
    expect(rvcPayload.input).not.toHaveProperty("lyrics");
    expect(written.uploadedNames).toEqual(["ref_vocal_synced.wav", "vocal_dna_tuned.wav", "guide_raw.wav"]);
    expect(ffmpegSpawns.flat().join(" ")).not.toMatch(/amix/i);
    expect(ffmpegSpawns).toEqual([]);
  });

  it("falls back to ref_vocal_synced.wav when autotune fails", async () => {
    const errors: unknown[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      const job = await runVocalJob(
        styleVocalRequest("Take One"),
        { failAutotune: true, rvc: "reference", masterBytes: Uint8Array.from([1, 2, 3, 4]) },
        async (sessionId) => {
          const names = await readdir(path.join(process.env.HYBRID_TRACK_SCRATCH || "", sessionId));
          expect(names).toContain("ref_vocal_synced.wav");
          expect(names).not.toContain("vocal_dna_tuned.wav");
        },
      );
      expect(job.callsBeforeResponse).toEqual([]);
      expect(job.created.status).toBe("pending");
      expect(job.payload.status).toBe("completed");
      expect(job.payload.error).toBeNull();
      const autotunePayload = JSON.parse(
        job.calls.find((call) => call.body.includes(AUTOTUNE_VERSION_ID))?.body || "{}",
      ) as { version?: string; input?: Record<string, unknown> };
      expect(autotunePayload.version).toBe(AUTOTUNE_VERSION_HASH);
      expect(autotunePayload.input).toEqual({
        audio_file: "https://api.replicate.com/v1/files/ref_vocal_synced.wav",
        scale: "E:maj",
        output_format: "wav",
      });
      const guide = continuationInput(job.calls);
      expect(guide.input.lyrics).toBe(USER_LYRICS);
      expect(guide.input.lyrics).not.toContain("[Tempo:");
      expect(guide.input.lyrics).not.toContain("E:maj");
      expect(guide.input.is_instrumental).toBe(false);
      const rvcPayload = JSON.parse(job.calls.find((call) => call.body.includes(RVC_VERSION))?.body || "{}") as {
        input?: Record<string, unknown>;
      };
      expect(String(rvcPayload.input?.reference_audio)).toContain("ref_vocal_synced.wav");
      expect(String(rvcPayload.input?.reference_audio)).not.toContain("vocal_dna_tuned.wav");
      expect(job.uploadedNames).toEqual(["ref_vocal_synced.wav", "ref_vocal_synced.wav", "guide_raw.wav"]);
      expect(errors.some((entry) => JSON.stringify(entry).includes("nateraw/autotune"))).toBe(true);
      expect(job.calls.some((call) => call.url.includes("music-01"))).toBe(false);
      expect(ffmpegSpawns).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("prefers vocal_dna_file bytes over the vocal_file fallback", async () => {
    const form = new FormData();
    form.append("prompt", STYLE_PROMPT);
    form.append("bpm", "86");
    form.append("vocal_present", "true");
    form.append("lyrics", USER_LYRICS);
    form.append(
      "vocal_dna_file",
      new File([new Uint8Array(64)], "vocal_dna.wav", { type: "audio/wav" }),
      "vocal_dna.wav",
    );
    form.append(
      "vocal_file",
      new File([new Uint8Array(128)], "ref_vocal.wav", { type: "audio/wav" }),
      "ref_vocal.wav",
    );
    await runVocalJob(
      new Request("http://127.0.0.1:3000/api/tracks/create", { method: "POST", body: form }),
      { failPrediction: true },
      async (sessionId) => {
        const dna = await stat(path.join(process.env.HYBRID_TRACK_SCRATCH || "", sessionId, "vocal_dna.wav"));
        const raw = await stat(path.join(process.env.HYBRID_TRACK_SCRATCH || "", sessionId, "ref_vocal_raw.wav"));
        expect(dna.size).toBe(64);
        expect(raw.size).toBe(64);
      },
    );
  });

  it("writes a lyria download as the master and does not run ffmpeg", async () => {
    await withScratch(async () => {
      process.env.REPLICATE_API_TOKEN = "test-token-not-live";
      const net = installFetch((url) => {
        if (url.startsWith("https://audio.test/")) return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 });
        return Response.json({ id: "pred_lyria", status: "succeeded", output: "https://audio.test/lyria.wav" });
      });
      const response = await handleTrackCreate(jsonRequest({ prompt: PROMPT }));
      expect(response.status).toBe(200);
      expect(net.calls).toEqual([]);
      net.arm();
      const created = (await response.json()) as { session_id: string; vocal_present: boolean };
      expect(created.vocal_present).toBe(false);
      const payload = await waitForTerminal(created.session_id);
      expect(net.calls.some((call) => call.url.includes(`/models/${LYRIA_MODEL_ID}/predictions`))).toBe(true);
      expect(net.calls.some((call) => call.url.includes("music-01"))).toBe(false);
      expect(net.calls.some((call) => call.url.includes(MINIMAX_VERSION_ID))).toBe(false);
      expect(payload.status).toBe("completed");
      expect(payload.master_url).toBe(`/api/stream/${created.session_id}_master.wav`);
      expect(ffmpegSpawns).toEqual([]);
      expect(syncState.calls).toEqual([]);
    });
  });
});

type JobView = {
  status: string;
  error: string | null;
  master_url: string | null;
};

type SeenCall = { url: string; body: string };

function styleVocalRequest(title = "Upbeat Pop"): Request {
  return vocalForm({
    prompt: STYLE_PROMPT,
    title,
    style: "upbeat pop",
    bpm: "86",
    duration: "210",
    lyrics: USER_LYRICS,
    key: "E Major",
  });
}

function vocalForm(fields: {
  prompt: string;
  title?: string;
  style?: string;
  genre?: string;
  bpm?: string;
  duration?: string;
  lyrics?: string;
  key?: string;
  field?: "vocal_file" | "voice_sample";
}): Request {
  const form = new FormData();
  form.append("prompt", fields.prompt);
  form.append("bpm", fields.bpm ?? "86");
  form.append("duration", fields.duration ?? "210");
  form.append("vocal_present", "true");
  if (fields.lyrics != null) form.append("lyrics", fields.lyrics);
  if (fields.key) form.append("key", fields.key);
  if (fields.title) form.append("title", fields.title);
  if (fields.style) form.append("style", fields.style);
  if (fields.genre) form.append("genre", fields.genre);
  form.append(fields.field ?? "vocal_file", vocalFile(), "ref_vocal.wav");
  return new Request("http://127.0.0.1:3000/api/tracks/create", { method: "POST", body: form });
}

function continuationInput(calls: SeenCall[]): { prompt: string; input: Record<string, unknown> } {
  const prediction = calls.find((call) => call.body.includes(MINIMAX_VERSION_ID));
  const payload = JSON.parse(prediction?.body || "{}") as { input?: Record<string, unknown> };
  return {
    prompt: String(payload.input?.prompt || ""),
    input: payload.input || {},
  };
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  let allowModel = false;
  const calls: SeenCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!allowModel) throw new Error(`Replicate was called before the create response: ${url}`);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    arm() {
      allowModel = true;
    },
  };
}

async function withScratch<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ht-create-"));
  const previous = process.env.HYBRID_TRACK_SCRATCH;
  process.env.HYBRID_TRACK_SCRATCH = dir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HYBRID_TRACK_SCRATCH;
    else process.env.HYBRID_TRACK_SCRATCH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitForTerminal(sessionId: string): Promise<JobView> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const payload = (await trackStatusResponse(sessionId).json()) as JobView;
    if (payload.status === "failed" || payload.status === "completed") return payload;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`job ${sessionId} did not finish`);
}

async function runVocalJob(
  request: Request,
  options: {
    failPrediction?: boolean;
    predictionStatus?: number;
    guideBytes?: Uint8Array;
    masterBytes?: Uint8Array;
    failAutotune?: boolean;
    rvc?: "missing" | "zip" | "reference";
  } = {},
  inspect?: (sessionId: string) => Promise<void>,
): Promise<{
  sessionId: string;
  created: Record<string, unknown>;
  payload: JobView;
  calls: SeenCall[];
  callsBeforeResponse: SeenCall[];
  uploadedName: string;
  uploadedNames: string[];
}> {
  return withScratch(async () => {
    process.env.REPLICATE_API_TOKEN = "test-token-not-live";
    const uploadedNames: string[] = [];
    const net = installFetch((url, init) => {
      if (url.includes("music-01") || url.includes(LYRIA_MODEL_ID)) {
        throw new Error(`unexpected engine ${url}`);
      }
      if (url === RVC_LOOKUP_URL) {
        if (options.rvc === "zip") return Response.json(zipOnlySchema());
        if (options.rvc === "reference") return Response.json(referenceAudioSchema());
        return Response.json({ detail: "Model not found." }, { status: 404 });
      }
      if (url.endsWith("/files") && init?.body instanceof FormData) {
        const content = init.body.get("content");
        const name = content instanceof File ? content.name : "";
        if (name) uploadedNames.push(name);
        return Response.json({
          urls: { get: `https://api.replicate.com/v1/files/${encodeURIComponent(name || "audio.wav")}` },
        });
      }
      if (url.endsWith("/predictions")) {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        const version = bodyText ? (JSON.parse(bodyText) as { version?: string }).version : "";
        if (version === AUTOTUNE_VERSION_ID) {
          if (options.failAutotune) {
            return Response.json({ id: "pred_autotune", status: "failed", error: "autotune mocked failure" });
          }
          return Response.json({ id: "pred_autotune", status: "succeeded", output: TUNED_URL });
        }
        if (options.predictionStatus && options.predictionStatus !== 200) {
          return new Response(JSON.stringify({ detail: "missing" }), {
            status: options.predictionStatus,
            headers: { "content-type": "application/json" },
          });
        }
        if (options.failPrediction) {
          return Response.json({ id: "pred_guide", status: "failed", error: "mocked" });
        }
        if (version === MINIMAX_VERSION_ID) {
          return Response.json({ id: "pred_guide", status: "succeeded", output: GUIDE_URL });
        }
        return Response.json({ id: "pred_rvc", status: "succeeded", output: MASTER_URL });
      }
      if (url === TUNED_URL) {
        return new Response(audioBlob(Uint8Array.from([4, 4, 4, 4])), { status: 200 });
      }
      if (url === GUIDE_URL) {
        return new Response(audioBlob(options.guideBytes ?? Uint8Array.from([1, 2, 3, 4])), { status: 200 });
      }
      if (url === MASTER_URL) {
        return new Response(audioBlob(options.masterBytes ?? Uint8Array.from([9, 8, 7, 6])), { status: 200 });
      }
      throw new Error(`unexpected HTTP ${url}`);
    });
    const response = await handleTrackCreate(request);
    const callsBeforeResponse = [...net.calls];
    expect(response.status).toBe(200);
    expect(callsBeforeResponse).toEqual([]);
    net.arm();
    const created = (await response.json()) as Record<string, unknown>;
    const sessionId = String(created.session_id);
    const payload = await waitForTerminal(sessionId);
    if (inspect) await inspect(sessionId);
    return {
      sessionId,
      created,
      payload,
      calls: net.calls,
      callsBeforeResponse,
      uploadedName: uploadedNames.join(","),
      uploadedNames,
    };
  });
}
