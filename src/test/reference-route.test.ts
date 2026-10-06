import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/reference/route";

const UPLOAD_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/create-upload-id";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function referenceRequest(form: FormData): Request {
  return { formData: async () => form } as Request;
}

describe("POST /api/reference", () => {
  const originalKey = process.env.WAVESPEED_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.WAVESPEED_API_KEY;
    else process.env.WAVESPEED_API_KEY = originalKey;
  });

  it("returns 400 when the audio file is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(referenceRequest(new FormData()));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Audio file is required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 500 when the WaveSpeed key is missing", async () => {
    delete process.env.WAVESPEED_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.append("file", new File(["riff"], "take.wav", { type: "audio/wav" }));

    const res = await POST(referenceRequest(form));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Missing WaveSpeed API key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps upload_id to referenceId without calling the network", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: { upload_id: "up_abc" } }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.append("file", new File(["riff"], "swamp.wav", { type: "audio/wav" }));

    const res = await POST(referenceRequest(form));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      referenceId: "up_abc",
      filename: "swamp.wav",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UPLOAD_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer test-key" });
    expect(init.body).toBeInstanceOf(FormData);
  });
});
