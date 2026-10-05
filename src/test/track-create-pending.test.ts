// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionFromCreateResponse } from "@/lib/create-session-id";
import {
  LYRIA_MODEL_ID,
  MINIMAX_VERSION_ID,
  handleTrackCreate,
  resetTrackCreateForTests,
  trackStatusResponse,
} from "@/lib/track-create.server";

const LOUDNORM_FILTER =
  "[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[voc];[0:a]volume=0.85[bed];[bed][voc]amix=inputs=2:duration=first:dropout_transition=2[out]";

const ffmpegHooks = vi.hoisted(() => ({
  spawn: null as null | ((command: string, args: readonly string[]) => EventEmitter),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn(command: string, args?: readonly string[], options?: unknown) {
      if (command === "ffmpeg" && ffmpegHooks.spawn) return ffmpegHooks.spawn(command, args ?? []);
      return actual.spawn(command, args as string[], options as never);
    },
  };
});

const PROMPT = "A bright analog house groove with a soft vocal hook and roomy drums tonight.";

const originalFetch = globalThis.fetch;
const originalToken = process.env.REPLICATE_API_TOKEN;

afterEach(() => {
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

describe("POST /api/tracks/create on port 3000", () => {
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
    expect(calls.some((url) => url.includes("8880"))).toBe(false);
    expect(calls.some((url) => url.includes(MINIMAX_VERSION_ID))).toBe(false);
  });

  it("saves a vocal and schedules one instrumental minimax prediction without uploading it", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token-not-live";
    const seen: Array<{ url: string; body: string }> = [];
    let allowModel = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!allowModel) throw new Error("Replicate was called before the create response");
      seen.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
      return new Response(JSON.stringify({ id: "pred_test", status: "failed", error: "mocked" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const form = new FormData();
    form.append("prompt", PROMPT);
    form.append("bpm", "100");
    form.append(
      "vocal_file",
      new File([new Uint8Array(128)], "ref_vocal.wav", { type: "audio/wav" }),
      "ref_vocal.wav",
    );
    const request = new Request("http://127.0.0.1:3000/api/tracks/create", { method: "POST", body: form });
    const response = await handleTrackCreate(request);
    expect(seen).toEqual([]);
    expect(response.status).toBe(200);
    allowModel = true;
    const body = (await response.json()) as { vocal_present: boolean; session_id: string };
    expect(body.vocal_present).toBe(true);
    expect(body.session_id).toMatch(/^ht_[0-9a-f]{12}$/);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toMatch(/\/predictions$/);
    expect(seen[0].url).not.toContain(LYRIA_MODEL_ID);
    const payload = JSON.parse(seen[0].body) as {
      version: string;
      input: Record<string, unknown>;
    };
    expect(payload.version).toBe(MINIMAX_VERSION_ID);
    expect(payload.input.is_instrumental).toBe(true);
    expect(JSON.stringify(payload.input)).not.toMatch(/audio_file|ref_vocal|data:audio/i);
    expect(payload.input).not.toHaveProperty("audio");
  });

  it("fails the vocal job when ffmpeg is missing and does not mark it completed", async () => {
    const ffmpegArgs: string[][] = [];
    ffmpegHooks.spawn = (_command, args) => {
      ffmpegArgs.push([...args]);
      return fakeFfmpeg((child) => {
        child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
        child.emit("close", null);
      });
    };
    const job = await runVocalMix();
    expect(ffmpegArgs).toHaveLength(1);
    expect(ffmpegArgs[0]).toContain(LOUDNORM_FILTER);
    expect(ffmpegArgs[0]).toEqual(expect.arrayContaining(["-map", "[out]", "-ar", "44100", "-ac", "2"]));
    expect(ffmpegArgs[0].some((arg) => arg.endsWith("bed_instrumental.wav"))).toBe(true);
    expect(ffmpegArgs[0].some((arg) => arg.endsWith(`${job.sessionId}_master.wav`))).toBe(true);
    expect(job.payload.status).toBe("failed");
    expect(job.payload.error).toBe("ffmpeg is not installed");
    expect(job.payload.master_url).toBeNull();
    expect(job.calls[0]?.url).toMatch(/\/predictions$/);
    const body = JSON.parse(job.calls[0]?.body || "{}") as { version?: string; input?: { is_instrumental?: boolean } };
    expect(body.version).toBe(MINIMAX_VERSION_ID);
    expect(body.input?.is_instrumental).toBe(true);
  });

  it("fails the vocal job with ffmpeg stderr when the mix exits non-zero", async () => {
    ffmpegHooks.spawn = () =>
      fakeFfmpeg((child) => {
        child.stderr.emit("data", "loudnorm failed: invalid data\n");
        child.emit("close", 1);
      });
    const job = await runVocalMix();
    expect(job.payload.status).toBe("failed");
    expect(job.payload.error).toBe("loudnorm failed: invalid data");
    expect(job.payload.master_url).toBeNull();
  });

  it("does not complete a vocal mix until the master wav exists and is non-empty", async () => {
    ffmpegHooks.spawn = () => fakeFfmpeg((child) => child.emit("close", 0));
    const empty = await runVocalMix();
    expect(empty.payload.status).toBe("failed");
    expect(empty.payload.error).toBe("master wav is missing");
    expect(empty.payload.master_url).toBeNull();

    ffmpegHooks.spawn = (_command, args) =>
      fakeFfmpeg((child) => {
        writeFileSync(args[args.length - 1]!, Buffer.from("RIFFmaster"));
        child.emit("close", 0);
      });
    const written = await runVocalMix();
    expect(written.payload.status).toBe("completed");
    expect(written.payload.error).toBeNull();
    expect(written.payload.master_url).toBe(`/api/stream/${written.sessionId}_master.wav`);
  });

  it("writes a lyria download as the master and does not run ffmpeg", async () => {
    ffmpegHooks.spawn = () => {
      throw new Error("ffmpeg should not run");
    };
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
      expect(net.calls.some((call) => call.url.includes(MINIMAX_VERSION_ID))).toBe(false);
      expect(payload.status).toBe("completed");
      expect(payload.master_url).toBe(`/api/stream/${created.session_id}_master.wav`);
    });
  });
});

type JobView = {
  status: string;
  error: string | null;
  master_url: string | null;
};

function vocalRequest(): Request {
  const form = new FormData();
  form.append("prompt", PROMPT);
  form.append("bpm", "100");
  form.append("vocal_file", new File([new Uint8Array(128)], "ref_vocal.wav", { type: "audio/wav" }), "ref_vocal.wav");
  return new Request("http://127.0.0.1:3000/api/tracks/create", { method: "POST", body: form });
}

function installFetch(handler: (url: string) => Response) {
  let allowModel = false;
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!allowModel) throw new Error(`Replicate was called before the create response: ${url}`);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return handler(url);
  }) as typeof fetch;
  return {
    calls,
    arm() {
      allowModel = true;
    },
  };
}

function fakeFfmpeg(play: (child: EventEmitter & { stderr: EventEmitter }) => void) {
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = stderr;
  process.nextTick(() => play(child));
  return child;
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

async function runVocalMix(): Promise<{ sessionId: string; payload: JobView; calls: Array<{ url: string; body: string }> }> {
  return withScratch(async () => {
    process.env.REPLICATE_API_TOKEN = "test-token-not-live";
    const net = installFetch((url) => {
      if (url.startsWith("https://audio.test/")) return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 });
      return Response.json({ id: "pred_bed", status: "succeeded", output: "https://audio.test/bed.wav" });
    });
    const response = await handleTrackCreate(vocalRequest());
    expect(response.status).toBe(200);
    expect(net.calls).toEqual([]);
    net.arm();
    const created = (await response.json()) as { session_id: string };
    const payload = await waitForTerminal(created.session_id);
    return { sessionId: created.session_id, payload, calls: net.calls };
  });
}
