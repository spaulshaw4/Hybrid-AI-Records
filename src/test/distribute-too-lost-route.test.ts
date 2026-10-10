import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fromMock,
  resolveStudioSessionMock,
  balanceMaybeSingleMock,
  profileUpdateMock,
  profileUpdateResultMock,
  spendRpcMock,
  getTooLostClientMock,
} = vi.hoisted(() => ({
  fromMock: vi.fn(),
  resolveStudioSessionMock: vi.fn(),
  balanceMaybeSingleMock: vi.fn(),
  profileUpdateMock: vi.fn(),
  profileUpdateResultMock: vi.fn(),
  spendRpcMock: vi.fn(),
  getTooLostClientMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      fromMock(table);
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => balanceMaybeSingleMock(),
            }),
          }),
          update: (payload: unknown) => ({
            eq: (column: string, value: string) => ({
              gte: (gteColumn: string, gteValue: number) => ({
                select: async () => {
                  profileUpdateMock({ payload, column, value, gteColumn, gteValue });
                  return profileUpdateResultMock();
                },
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      };
    },
    rpc: (fn: string, args: unknown) => spendRpcMock(fn, args),
  }),
}));

vi.mock("@/lib/studio-request-auth.server", () => ({
  resolveStudioSession: (...args: unknown[]) => resolveStudioSessionMock(...args),
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {
    status = 401;
    constructor(message = "Unauthorized session") {
      super(message);
      this.name = "UnauthorizedSessionError";
    }
  },
}));

vi.mock("@/lib/too-lost/get-client", () => ({
  getTooLostClient: (...args: unknown[]) => getTooLostClientMock(...args),
}));

import { POST } from "@/app/api/distribute/too-lost/route";

const SESSION_USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RECORDING_TYPE = "100% Original Human Recording";

const ENTERPRISE = {
  enable_content_id: true,
  enable_publishing_admin: true,
  enable_discovery_mode: true,
  auto_generate_isrc: true,
  auto_generate_upc: true,
  territories: "worldwide",
  stores: "all",
};

function wavBytes(bits = 16): Uint8Array {
  const bytes = new Uint8Array(44);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12);
  bytes[34] = bits & 0xff;
  bytes[35] = (bits >> 8) & 0xff;
  return bytes;
}

function flacBytes(): Uint8Array {
  return new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0]);
}

function jpegFrame(width: number, height: number): Uint8Array {
  const hh = (height >> 8) & 0xff;
  const hl = height & 0xff;
  const wh = (width >> 8) & 0xff;
  const wl = width & 0xff;
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, hh, hl, wh, wl, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11,
    0x00, 0xff, 0xd9,
  ]);
}

function jpegSquare(size: number): Uint8Array {
  return jpegFrame(size, size);
}

function multipartBody(
  fields: Record<string, string>,
  files: Array<{ field: string; name: string; type: string; bytes: Uint8Array }>,
): { body: Buffer; contentType: string } {
  const boundary = "----toolosttest";
  const chunks: Buffer[] = [];
  const push = (text: string) => chunks.push(Buffer.from(text, "utf8"));
  for (const [key, value] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  for (const file of files) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    );
    chunks.push(Buffer.from(file.bytes));
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function uploadCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const input = call[0] as RequestInfo | URL;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith("https://uploads.example/");
  });
}

function distributeRequest(extra?: {
  authorization?: string | null;
  userId?: string;
  fields?: Record<string, string>;
  omit?: string[];
  audio?: { name: string; type: string; bytes: Uint8Array };
  cover?: { name: string; type: string; bytes: Uint8Array };
}): Request {
  const fields: Record<string, string> = {
    title: "Northline",
    artist: "Ada Voss",
    source: "upload",
    acceptTerms: "true",
    confirmRights: "true",
    genre: "Hip-Hop",
    explicit: "false",
    composer: "Ada Voss",
    lyricist: "Ada Voss",
    pLine: "Hybrid AI Records LLC",
    cLine: "Ada Voss",
    recordingType: RECORDING_TYPE,
    sampleClearance: "true",
    enable_content_id: "false",
    userId: extra?.userId ?? "attacker-user",
    ...extra?.fields,
  };
  for (const key of extra?.omit ?? []) delete fields[key];
  const audio = extra?.audio ?? { name: "master.wav", type: "audio/wav", bytes: wavBytes() };
  const cover = extra?.cover ?? { name: "cover.jpg", type: "image/jpeg", bytes: jpegSquare(3000) };
  const { body, contentType } = multipartBody(fields, [
    { field: "cover", name: cover.name, type: cover.type, bytes: cover.bytes },
    { field: "audio", name: audio.name, type: audio.type, bytes: audio.bytes },
  ]);
  const headers = new Headers({ "content-type": contentType });
  if (extra?.authorization !== null) headers.set("authorization", extra?.authorization ?? "Bearer a.b.c");
  return new Request("http://localhost/api/distribute/too-lost", {
    method: "POST",
    headers,
    body: body as unknown as BodyInit,
  });
}

describe("POST /api/distribute/too-lost", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchMock = vi.fn();
  const realFetch = globalThis.fetch.bind(globalThis);
  const client = {
    createDraftRelease: vi.fn(),
    getArtworkUploadUrl: vi.fn(),
    updateMetadata: vi.fn(),
    getTrackUploadUrl: vi.fn(),
    setTracklist: vi.fn(),
    updateDelivery: vi.fn(),
    submitRelease: vi.fn(),
  };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    balanceMaybeSingleMock.mockResolvedValue({ data: { d_tokens: 4 }, error: null });
    profileUpdateResultMock.mockResolvedValue({ data: [{ d_tokens: 3 }], error: null });
    spendRpcMock.mockResolvedValue({
      data: [{ ok: true, balance: 3, already_applied: false }],
      error: null,
    });
    client.createDraftRelease.mockResolvedValue({
      data: { id: 501, title: "Northline", type: "Single", status: "draft", participants: [] },
    });
    client.getArtworkUploadUrl.mockResolvedValue({
      data: {
        uploadUrl: "https://uploads.example/cover",
        fileKey: "covers/501/cover.jpg",
        headers: { "x-amz-meta-test": "1" },
      },
    });
    client.updateMetadata.mockResolvedValue({ data: { id: 501 } });
    client.getTrackUploadUrl.mockResolvedValue({
      data: {
        uploadUrl: "https://uploads.example/audio",
        fileKey: "audio/501/master.wav",
        headers: { "x-amz-meta-test": "1" },
      },
    });
    client.setTracklist.mockResolvedValue({ data: { id: 501 } });
    client.updateDelivery.mockResolvedValue({ data: { id: 501 } });
    client.submitRelease.mockResolvedValue({
      data: { id: 501, status: "in_review" },
      message: "Release submitted for review.",
      status: 200,
    });
    getTooLostClientMock.mockResolvedValue(client);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://uploads.example/audio" || url === "https://uploads.example/cover") {
        return new Response(null, { status: 200 });
      }
      return realFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fromMock.mockClear();
    resolveStudioSessionMock.mockReset();
    balanceMaybeSingleMock.mockReset();
    profileUpdateMock.mockReset();
    profileUpdateResultMock.mockReset();
    spendRpcMock.mockReset();
    getTooLostClientMock.mockReset();
    client.createDraftRelease.mockReset();
    client.getArtworkUploadUrl.mockReset();
    client.updateMetadata.mockReset();
    client.getTrackUploadUrl.mockReset();
    client.setTracklist.mockReset();
    client.updateDelivery.mockReset();
    client.submitRelease.mockReset();
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
  });

  it("returns 401 when the studio session is missing", async () => {
    const res = await POST(distributeRequest({ authorization: null }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized session" });
    expect(resolveStudioSessionMock).not.toHaveBeenCalled();
    expect(getTooLostClientMock).not.toHaveBeenCalled();
    expect(profileUpdateMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("does not call Too Lost when the D-Token balance is below 1", async () => {
    balanceMaybeSingleMock.mockResolvedValue({ data: { d_tokens: 0 }, error: null });

    const res = await POST(distributeRequest());

    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toEqual({ error: "You need 1 D-Token to distribute a release." });
    expect(fromMock).toHaveBeenCalledWith("profiles");
    expect(getTooLostClientMock).not.toHaveBeenCalled();
    expect(client.createDraftRelease).not.toHaveBeenCalled();
    expect(profileUpdateMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("returns 503 and does not call Too Lost when profiles.d_tokens is missing", async () => {
    balanceMaybeSingleMock.mockResolvedValue({
      data: null,
      error: { code: "42703", message: "column profiles.d_tokens does not exist" },
    });

    const res = await POST(distributeRequest());

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "D-Token balance is not available." });
    expect(getTooLostClientMock).not.toHaveBeenCalled();
    expect(profileUpdateMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
  });

  it("decrements 1 D-Token after Too Lost returns 200 with an id and ignores body userId", async () => {
    const year = new Date().getFullYear();
    const cLine = `${year} Ada Voss`;
    const pLine = `${year} Hybrid AI Records`;
    const res = await POST(distributeRequest({ userId: "attacker-user" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      releaseId: 501,
      balance: 3,
      status: "in_review",
      spotifyUri: null,
      upc: null,
    });
    expect(getTooLostClientMock).toHaveBeenCalledTimes(1);
    expect(client.createDraftRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Northline",
        type: "Single",
        release_type: "single",
        label: "Hybrid AI Records LLC",
        genre: "Hip-Hop",
        language: "English",
        c_line: cLine,
        p_line: pLine,
        participants: [{ name: "Ada Voss", role: ["primary"] }],
        ...ENTERPRISE,
      }),
    );
    expect(client.getArtworkUploadUrl).toHaveBeenCalledWith(501, "cover.jpg", "image/jpeg");
    expect(client.updateMetadata).toHaveBeenCalledWith(
      501,
      expect.objectContaining({
        coverFileKey: "covers/501/cover.jpg",
        genre: "Hip-Hop",
        label: "Hybrid AI Records LLC",
        release_type: "single",
        language: "English",
        c_line: cLine,
        p_line: pLine,
      }),
    );
    expect(client.getTrackUploadUrl).toHaveBeenCalledWith(501, "master.wav", "audio/wav", "audio");
    expect(client.setTracklist).toHaveBeenCalledWith(501, [
      expect.objectContaining({
        title: "Northline",
        composer: "Ada Voss",
        lyricist: "Ada Voss",
        p_line: pLine,
        c_line: cLine,
        language: "English",
        recording_type: RECORDING_TYPE,
        is_explicit: false,
        artists: [{ name: "Ada Voss", role: ["primary"] }],
      }),
    ]);
    expect(uploadCalls(fetchMock)).toHaveLength(2);
    expect(client.submitRelease).toHaveBeenCalledWith(
      501,
      expect.objectContaining({ acceptTerms: true, confirmRights: true }),
    );
    expect(profileUpdateMock).toHaveBeenCalledTimes(1);
    expect(profileUpdateMock).toHaveBeenCalledWith({
      payload: { d_tokens: 3 },
      column: "user_id",
      value: SESSION_USER,
      gteColumn: "d_tokens",
      gteValue: 1,
    });
    expect(spendRpcMock).not.toHaveBeenCalled();
  });

  it("debits one D-Token when Too Lost returns 201 with an id and returns store codes", async () => {
    client.submitRelease.mockResolvedValue({
      data: { id: 501, status: "live", upc: "012345678905", spotifyUri: "spotify:album:abc123" },
      message: "Created.",
      status: 201,
    });

    const res = await POST(distributeRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      releaseId: 501,
      balance: 3,
      status: "live",
      spotifyUri: "spotify:album:abc123",
      upc: "012345678905",
    });
    expect(profileUpdateMock).toHaveBeenCalledTimes(1);
    expect(spendRpcMock).not.toHaveBeenCalled();
  });

  it("accepts an uploaded FLAC and still sends the enterprise flags", async () => {
    const res = await POST(
      distributeRequest({
        audio: { name: "master.flac", type: "audio/flac", bytes: flacBytes() },
        fields: { explicit: "true" },
      }),
    );

    expect(res.status).toBe(200);
    expect(client.getTrackUploadUrl).toHaveBeenCalledWith(501, "master.flac", "audio/flac", "audio");
    expect(client.setTracklist).toHaveBeenCalledWith(
      501,
      [expect.objectContaining({ is_explicit: true, recording_type: RECORDING_TYPE })],
    );
    expect(client.createDraftRelease).toHaveBeenCalledWith(expect.objectContaining(ENTERPRISE));
    expect(profileUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("does not debit when Too Lost returns 200 without a release id", async () => {
    client.submitRelease.mockResolvedValue({
      data: { status: "in_review" },
      message: "Release submitted for review.",
      status: 200,
    });

    const res = await POST(distributeRequest());

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("Nothing was charged");
    expect(getTooLostClientMock).toHaveBeenCalledTimes(1);
    expect(client.submitRelease).toHaveBeenCalledTimes(1);
    expect(profileUpdateMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
  });

  it("does not debit when Too Lost returns 202 even if an id is present", async () => {
    client.submitRelease.mockResolvedValue({
      data: { id: 501, status: "in_review" },
      message: "Accepted for processing.",
      status: 202,
    });

    const res = await POST(distributeRequest());

    expect(res.status).toBe(502);
    expect(profileUpdateMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
  });

  it("does not decrement a D-Token when Too Lost rejects the release", async () => {
    client.submitRelease.mockRejectedValue(new Error("Bearer super-secret-token\n    at TooLostClient.request"));

    const res = await POST(distributeRequest());
    const body = await res.text();

    expect(res.status).toBe(502);
    expect(body).toContain("Nothing was charged");
    expect(body).not.toContain("super-secret-token");
    expect(body).not.toContain("TooLostClient");
    expect(getTooLostClientMock).toHaveBeenCalledTimes(1);
    expect(client.submitRelease).toHaveBeenCalledTimes(1);
    expect(profileUpdateMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
  });

  it("rejects a non-square or tiny cover before Too Lost", async () => {
    const res = await POST(
      distributeRequest({
        cover: { name: "cover.jpg", type: "image/jpeg", bytes: jpegFrame(100, 200) },
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/square|3000/i);
    expect(getTooLostClientMock).not.toHaveBeenCalled();
    expect(profileUpdateMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
  });

  it("does not call Too Lost or debit when the clearance checkbox is missing", async () => {
    const res = await POST(distributeRequest({ omit: ["sampleClearance"] }));

    expect(res.status).toBe(400);
    expect(getTooLostClientMock).not.toHaveBeenCalled();
    expect(profileUpdateMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
  });

  it("does not call Too Lost or debit when the composer is empty", async () => {
    const res = await POST(distributeRequest({ fields: { composer: "   " } }));

    expect(res.status).toBe(400);
    expect(getTooLostClientMock).not.toHaveBeenCalled();
    expect(profileUpdateMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
  });
});
