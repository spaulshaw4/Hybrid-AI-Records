import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordSuccess } from "@/lib/circuit-breaker.server";
import { validatePayload } from "@/lib/pipeline-guard.server";
import { createVisualRender, pollVisualRender } from "@/lib/cinematic-pipeline.server";
import { lipsyncShot, LIPSYNC_MODEL } from "@/lib/lipsync.server";
import {
  assertHailuoDuration,
  cancelPrediction,
  createFoundationFrame,
  createMotionBlock,
  firstOutputUrl,
  FLUX_DEV_MODEL,
  FLUX_DEV_SIZE_16_9,
  HAILUO_I2V_MODEL,
  readPrediction,
  resolveCinematicMotion,
  SEEDANCE_I2V_MODEL,
  VisualEngineError,
} from "@/lib/visual-engines.server";

const WAVESPEED_KEY = "ws_test_cinematic_key";
const REPLICATE_TOKEN = "r8_must_not_reach_wavespeed";
const STILL_URL = "https://cdn.example/still.png";
const CLIP_URL = "https://cdn.example/clip.mp4";
const START_IMAGE = "https://cdn.example/keyframe.png";
const PROMPT = "A cinematic night street, continuous moving camera, rain on neon signs.";

const ENV_NAMES = [
  "WAVESPEED_API_KEY",
  "REPLICATE_API_TOKEN",
  "REPLICATE_API_KEY",
  "GOOGLE_PAID_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_FREE_API_KEY",
] as const;

type Call = { url: string; init?: RequestInit };

const calls: Call[] = [];
const savedEnv = new Map<string, string | undefined>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function clearName(name: string) {
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === name.toLowerCase()) delete process.env[key];
  }
}

function expectWaveSpeedAuth(init: RequestInit | undefined) {
  expect(header(init, "authorization")).toBe(`Bearer ${WAVESPEED_KEY}`);
  const serialized = JSON.stringify({
    url: "",
    headers: Object.fromEntries(new Headers(init?.headers)),
    body: init?.body,
  });
  expect(serialized).not.toContain(REPLICATE_TOKEN);
  expect(serialized.toLowerCase()).not.toContain("replicate");
}

beforeEach(() => {
  calls.length = 0;
  for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);
  for (const name of ENV_NAMES) clearName(name);
  process.env.WAVESPEED_API_KEY = WAVESPEED_KEY;
  process.env.REPLICATE_API_TOKEN = REPLICATE_TOKEN;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/v3/tasks")) return jsonResponse({ message: "tasks route" }, 500);
      return jsonResponse({ message: `unexpected ${url}` }, 500);
    }),
  );
});

afterEach(() => {
  recordSuccess(HAILUO_I2V_MODEL);
  recordSuccess(SEEDANCE_I2V_MODEL);
  recordSuccess(FLUX_DEV_MODEL);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of ENV_NAMES) {
    clearName(name);
    const previous = savedEnv.get(name);
    if (previous !== undefined) process.env[name] = previous;
  }
});

describe("cinematic motion duration contract", () => {
  it("keeps 5 seconds on Seedance and refuses to send 5 to Hailuo", () => {
    expect(resolveCinematicMotion(5)).toEqual([
      { id: "primary", model: SEEDANCE_I2V_MODEL, duration: 5 },
    ]);
    expect(resolveCinematicMotion(4)).toEqual([
      { id: "primary", model: SEEDANCE_I2V_MODEL, duration: 4 },
    ]);
    expect(resolveCinematicMotion(8)).toEqual([
      { id: "primary", model: SEEDANCE_I2V_MODEL, duration: 8 },
    ]);
    expect(resolveCinematicMotion(6)).toEqual([
      { id: "primary", model: HAILUO_I2V_MODEL, duration: 6 },
      { id: "reserve", model: SEEDANCE_I2V_MODEL, duration: 6 },
    ]);
    expect(resolveCinematicMotion(10)).toEqual([
      { id: "primary", model: HAILUO_I2V_MODEL, duration: 10 },
      { id: "reserve", model: SEEDANCE_I2V_MODEL, duration: 10 },
    ]);
    expect(() => assertHailuoDuration(5)).toThrow(VisualEngineError);
    expect(() => assertHailuoDuration(5)).toThrow(
      /Hailuo 2\.3 accepts only 6 or 10 seconds\. Refusing to send 5\./,
    );
    expect(() => assertHailuoDuration(8)).toThrow(/Refusing to send 8/);
    expect(assertHailuoDuration(6)).toBe(6);
    expect(assertHailuoDuration(10)).toBe(10);
  });
});

describe("WaveSpeed stills and motion", () => {
  it("posts flux-dev and reads data.outputs[0]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith(`/api/v3/${FLUX_DEV_MODEL}`) && init?.method === "POST") {
          return jsonResponse({ data: { id: "pred_flux_01", status: "created" } });
        }
        if (url.endsWith("/predictions/pred_flux_01/result")) {
          return jsonResponse({
            data: {
              id: "pred_flux_01",
              status: "completed",
              outputs: [STILL_URL, "https://cdn.example/ignored.png"],
            },
          });
        }
        return jsonResponse({ message: `unexpected ${url}` }, 500);
      }),
    );

    const url = await createFoundationFrame(PROMPT, ["data:image/png;base64,aaaa"]);
    expect(url).toBe(STILL_URL);
    const post = calls[0]!;
    expect(post.url).toBe(`https://api.wavespeed.ai/api/v3/${FLUX_DEV_MODEL}`);
    expect(post.init?.method).toBe("POST");
    expectWaveSpeedAuth(post.init);
    expect(jsonBody(post.init)).toMatchObject({
      size: FLUX_DEV_SIZE_16_9,
      output_format: "png",
      num_inference_steps: 28,
    });
    expect(jsonBody(post.init)).not.toHaveProperty("image");
    expect(jsonBody(post.init)).not.toHaveProperty("input");
    expect(calls[1]?.url).toBe("https://api.wavespeed.ai/api/v3/predictions/pred_flux_01/result");
    expect(
      calls.every(
        (call) => !call.url.includes("/tasks") && !call.url.includes("api.replicate.com"),
      ),
    ).toBe(true);
  });

  it("sends a 5 second block to Seedance and never to Hailuo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith(`/api/v3/${SEEDANCE_I2V_MODEL}`)) {
          return jsonResponse({ data: { id: "pred_seed_05", status: "processing" } });
        }
        return jsonResponse({ message: `unexpected ${url}` }, 500);
      }),
    );

    const job = await createMotionBlock({
      prompt: PROMPT,
      seconds: 5,
      referenceImage: START_IMAGE,
    });
    expect(job).toMatchObject({ id: "pred_seed_05", engine: "primary" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.wavespeed.ai/api/v3/${SEEDANCE_I2V_MODEL}`);
    expectWaveSpeedAuth(calls[0]?.init);
    expect(jsonBody(calls[0]?.init)).toEqual({
      image: START_IMAGE,
      prompt: expect.stringContaining("Avoid:"),
      duration: 5,
      resolution: "1080p",
      generate_audio: false,
    });
  });

  it("sends 6 seconds to Hailuo and falls back to Seedance at 6, not 5", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes(HAILUO_I2V_MODEL)) return jsonResponse({ message: "unavailable" }, 503);
        if (url.endsWith(`/api/v3/${SEEDANCE_I2V_MODEL}`)) {
          return jsonResponse({ data: { id: "pred_seed_06", status: "created" } });
        }
        return jsonResponse({ message: `unexpected ${url}` }, 500);
      }),
    );

    const job = await createMotionBlock({
      prompt: PROMPT,
      seconds: 6,
      referenceImage: START_IMAGE,
    });
    expect(job).toMatchObject({ id: "pred_seed_06", engine: "reserve" });
    expect(jsonBody(calls[0]?.init).duration).toBe(6);
    expect(Object.keys(jsonBody(calls[0]?.init)).sort()).toEqual(["duration", "image", "prompt"]);
    expect(jsonBody(calls[1]?.init).duration).toBe(6);
    expect(calls[1]?.url).toContain(SEEDANCE_I2V_MODEL);
    expect(calls.every((call) => !String(call.init?.body ?? "").includes(`"duration":5`))).toBe(
      true,
    );
  });

  it("sends an 8 second block to Seedance at 8 and does not call Hailuo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes("hailuo"))
          return jsonResponse({ message: "hailuo should not be called" }, 500);
        if (url.endsWith(`/api/v3/${SEEDANCE_I2V_MODEL}`)) {
          return jsonResponse({ message: "seedance down" }, 500);
        }
        return jsonResponse({ message: `unexpected ${url}` }, 500);
      }),
    );

    await expect(
      createMotionBlock({ prompt: PROMPT, seconds: 8, referenceImage: START_IMAGE }),
    ).rejects.toThrow(/Render rejected \[500\]/);
    expect(calls.map((call) => call.url).some((url) => url.includes("hailuo"))).toBe(false);
    expect(jsonBody(calls[0]?.init).duration).toBe(8);
  });

  it("does not call WaveSpeed when the key is missing, even if a Replicate token is set", async () => {
    clearName("WAVESPEED_API_KEY");
    await expect(
      createMotionBlock({ prompt: PROMPT, seconds: 8, referenceImage: START_IMAGE }),
    ).rejects.toThrow(/WAVESPEED_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it("requires a start image and does not invent a text-to-video route", async () => {
    await expect(createMotionBlock({ prompt: PROMPT, seconds: 8 })).rejects.toThrow(
      /requires a start image URL/,
    );
    expect(calls).toHaveLength(0);
  });

  it("reads the poll result from data.outputs[0] and hides the api key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/predictions/pred_done/result")) {
          return jsonResponse({
            message: `leaked ${WAVESPEED_KEY}`,
            data: {
              id: "pred_done",
              status: "completed",
              outputs: [CLIP_URL],
              created_at: "2026-01-01T00:00:00.000Z",
            },
          });
        }
        if (url.endsWith("/predictions/pred_bad/result")) {
          return jsonResponse({
            data: { id: "pred_bad", status: "failed", error: `nope ${WAVESPEED_KEY}`, outputs: [] },
          });
        }
        if (url.endsWith("/predictions/pred_stop/result")) {
          return jsonResponse({ data: { id: "pred_stop", status: "cancelled", outputs: [] } });
        }
        return jsonResponse({ message: `unexpected ${url}` }, 500);
      }),
    );

    const done = await readPrediction("pred_done");
    expect(done.status).toBe("succeeded");
    expect(firstOutputUrl(done.output)).toBe(CLIP_URL);
    expectWaveSpeedAuth(calls[0]?.init);
    const failed = await readPrediction("pred_bad");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("[REDACTED]");
    expect(failed.error).not.toContain(WAVESPEED_KEY);
    const stopped = await readPrediction("pred_stop");
    expect(stopped.status).toBe("canceled");

    const polled = await pollVisualRender("pred_done", "user-1");
    expect(polled).toMatchObject({ status: "completed", videoUrl: CLIP_URL, progress: 100 });
  });

  it("renders an 8 second studio block through flux-dev and then Seedance", async () => {
    process.env.GOOGLE_PAID_API_KEY = "google-paid";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith(`/api/v3/${FLUX_DEV_MODEL}`) && init?.method === "POST") {
          return jsonResponse({ data: { id: "pred_flux_02", status: "created" } });
        }
        if (url.endsWith("/predictions/pred_flux_02/result")) {
          return jsonResponse({
            data: { id: "pred_flux_02", status: "completed", outputs: [STILL_URL] },
          });
        }
        if (url.endsWith(`/api/v3/${SEEDANCE_I2V_MODEL}`) && init?.method === "POST") {
          return jsonResponse({ data: { id: "pred_seed_08", status: "created" } });
        }
        return jsonResponse({ message: `unexpected ${url}` }, 500);
      }),
    );

    const job = await createVisualRender(PROMPT, 8);
    expect(job).toMatchObject({ id: "pred_seed_08", engine: "primary" });
    expect(calls[0]?.url).toBe(`https://api.wavespeed.ai/api/v3/${FLUX_DEV_MODEL}`);
    expect(calls[2]?.url).toBe(`https://api.wavespeed.ai/api/v3/${SEEDANCE_I2V_MODEL}`);
    expect(jsonBody(calls[2]?.init)).toMatchObject({
      image: STILL_URL,
      duration: 8,
      resolution: "1080p",
      generate_audio: false,
    });
    expect(
      calls.some((call) => call.url.includes("api.replicate.com") || call.url.includes("hailuo")),
    ).toBe(false);
  });

  it("does not cancel through Replicate or a guessed WaveSpeed cancel route", async () => {
    await expect(cancelPrediction("pred_live_01")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("WaveSpeed lip-sync", () => {
  it("uploads the wav, posts sync/lipsync-3, and returns data.outputs[0]", async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/api/v3/media/uploads") && init?.method === "POST") {
          return jsonResponse({
            data: {
              download_url: "https://cdn.example/shot-audio.wav",
              upload: {
                method: "PUT",
                url: "https://storage.example/upload-ticket",
                headers: { "Content-Type": "audio/wav", Authorization: `Bearer ${WAVESPEED_KEY}` },
              },
            },
          });
        }
        if (url === "https://storage.example/upload-ticket")
          return new Response(null, { status: 200 });
        if (url.endsWith(`/api/v3/${LIPSYNC_MODEL}`) && init?.method === "POST") {
          return jsonResponse({ data: { id: "pred_lip_01", status: "created" } });
        }
        if (url.endsWith("/predictions/pred_lip_01/result")) {
          return jsonResponse({
            data: { id: "pred_lip_01", status: "completed", outputs: [CLIP_URL] },
          });
        }
        return jsonResponse({ message: `unexpected ${url}` }, 500);
      }),
    );

    const clip = await lipsyncShot({ videoUrl: CLIP_URL, audioWav: audio, shotIndex: 0 });
    expect(clip).toBe(CLIP_URL);
    expect(calls[0]?.url).toBe("https://api.wavespeed.ai/api/v3/media/uploads");
    expectWaveSpeedAuth(calls[0]?.init);
    expect(jsonBody(calls[0]?.init)).toEqual({
      filename: "shot_01_audio.wav",
      size: 4,
      content_type: "audio/wav",
    });
    const put = calls[1]!;
    expect(put.url).toBe("https://storage.example/upload-ticket");
    expect(put.init?.method).toBe("PUT");
    expect(header(put.init, "authorization")).toBeNull();
    expect(header(put.init, "content-type")).toBe("audio/wav");
    expect(new Uint8Array(put.init?.body as ArrayBuffer)).toEqual(audio);
    const submit = calls[2]!;
    expect(submit.url).toBe(`https://api.wavespeed.ai/api/v3/${LIPSYNC_MODEL}`);
    expectWaveSpeedAuth(submit.init);
    expect(jsonBody(submit.init)).toEqual({
      video: CLIP_URL,
      audio: "https://cdn.example/shot-audio.wav",
      sync_mode: "cut_off",
    });
    expect(calls[3]?.url).toBe("https://api.wavespeed.ai/api/v3/predictions/pred_lip_01/result");
    expect(
      calls.every(
        (call) => !call.url.includes("api.replicate.com") && !call.url.includes("/tasks"),
      ),
    ).toBe(true);
  });
});

describe("cinematic preflight", () => {
  const task = { shotId: "shot-1", prompt: "cinematic street at night" };

  it("accepts WaveSpeed plus the paid Google key and ignores a Replicate-only setup", () => {
    process.env.GOOGLE_PAID_API_KEY = "google-paid";
    process.env.WAVESPEED_API_KEY = WAVESPEED_KEY;
    expect(validatePayload(task)).toEqual({ isValid: true });

    clearName("WAVESPEED_API_KEY");
    process.env.REPLICATE_API_TOKEN = REPLICATE_TOKEN;
    expect(validatePayload(task)).toMatchObject({ isValid: false, code: 401 });

    clearName("GOOGLE_PAID_API_KEY");
    clearName("GEMINI_API_KEY");
    clearName("GEMINI_FREE_API_KEY");
    process.env.WAVESPEED_API_KEY = WAVESPEED_KEY;
    expect(validatePayload(task)).toMatchObject({ isValid: false, code: 401 });
  });
});

describe("cinematic video sources", () => {
  it("does not keep a Replicate video client or a /tasks submit path", () => {
    const files = [
      "src/lib/visual-engines.server.ts",
      "src/lib/lipsync.server.ts",
      "src/lib/lipsync.functions.ts",
      "src/lib/cinematic-pipeline.server.ts",
      "src/lib/cinematic-render.functions.ts",
      "src/lib/wavespeed-prediction.server.ts",
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("api.replicate.com");
      expect(text, file).not.toContain("/api/v3/tasks");
      expect(text, file).not.toContain("replicateHeaders");
      expect(text, file).not.toContain("wan-video");
      expect(text, file).not.toContain("wavespeed-ai/flux-pro");
      expect(text, file).not.toContain("sync/lipsync-2");
    }
  });
});
