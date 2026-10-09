import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock, resolveStudioSessionMock, balanceMaybeSingleMock, spendRpcMock, getTooLostClientMock } =
  vi.hoisted(() => ({
    fromMock: vi.fn(),
    resolveStudioSessionMock: vi.fn(),
    balanceMaybeSingleMock: vi.fn(),
    spendRpcMock: vi.fn(),
    getTooLostClientMock: vi.fn(),
  }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      fromMock(table);
      if (table === "token_balances") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => balanceMaybeSingleMock(),
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

function wavBytes(): Uint8Array {
  const bytes = new Uint8Array(44);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  return bytes;
}

function multipartBody(fields: Record<string, string>, file: { name: string; type: string; bytes: Uint8Array }): {
  body: Buffer;
  contentType: string;
} {
  const boundary = "----toolosttest";
  const chunks: Buffer[] = [];
  const push = (text: string) => chunks.push(Buffer.from(text, "utf8"));
  for (const [key, value] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  push(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
  );
  chunks.push(Buffer.from(file.bytes));
  push(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function uploadCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const input = call[0] as RequestInfo | URL;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith("https://uploads.example/");
  });
}

function distributeRequest(extra?: { authorization?: string | null; userId?: string }): Request {
  const { body, contentType } = multipartBody(
    {
      title: "Northline",
      artist: "Ada Voss",
      source: "upload",
      acceptTerms: "true",
      confirmRights: "true",
      userId: extra?.userId ?? "attacker-user",
    },
    { name: "master.wav", type: "audio/wav", bytes: wavBytes() },
  );
  const headers = new Headers({ "content-type": contentType });
  if (extra?.authorization !== null) headers.set("authorization", extra?.authorization ?? "Bearer a.b.c");
  return new Request("http://localhost/api/distribute/too-lost", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/distribute/too-lost", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchMock = vi.fn();
  const realFetch = globalThis.fetch.bind(globalThis);
  const client = {
    createDraftRelease: vi.fn(),
    getTrackUploadUrl: vi.fn(),
    setTracklist: vi.fn(),
    updateDelivery: vi.fn(),
    submitRelease: vi.fn(),
  };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    balanceMaybeSingleMock.mockResolvedValue({ data: { balance: 4 }, error: null });
    spendRpcMock.mockResolvedValue({
      data: [{ ok: true, balance: 3, already_applied: false }],
      error: null,
    });
    client.createDraftRelease.mockResolvedValue({
      data: { id: 501, title: "Northline", type: "Single", status: "draft", participants: [] },
    });
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
    });
    getTooLostClientMock.mockResolvedValue(client);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://uploads.example/audio") return new Response(null, { status: 200 });
      return realFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fromMock.mockClear();
    resolveStudioSessionMock.mockReset();
    balanceMaybeSingleMock.mockReset();
    spendRpcMock.mockReset();
    getTooLostClientMock.mockReset();
    client.createDraftRelease.mockReset();
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
    expect(spendRpcMock).not.toHaveBeenCalled();
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("does not call Too Lost when the D-Token balance is below 1", async () => {
    balanceMaybeSingleMock.mockResolvedValue({ data: { balance: 0 }, error: null });

    const res = await POST(distributeRequest());

    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toEqual({ error: "You need 1 D-Token to distribute a release." });
    expect(fromMock).toHaveBeenCalledWith("token_balances");
    expect(getTooLostClientMock).not.toHaveBeenCalled();
    expect(client.createDraftRelease).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("decrements 1 token after a successful Too Lost dispatch and ignores body userId", async () => {
    const res = await POST(distributeRequest({ userId: "attacker-user" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, releaseId: 501, balance: 3 });
    expect(getTooLostClientMock).toHaveBeenCalledTimes(1);
    expect(client.createDraftRelease).toHaveBeenCalledWith({
      title: "Northline",
      type: "Single",
      participants: [{ name: "Ada Voss", role: ["primary"] }],
    });
    expect(client.getTrackUploadUrl).toHaveBeenCalledWith(501, "master.wav", "audio/wav", "audio");
    expect(uploadCalls(fetchMock)).toHaveLength(1);
    const [uploadUrl, uploadInit] = uploadCalls(fetchMock)[0] as [string, RequestInit];
    expect(uploadUrl).toBe("https://uploads.example/audio");
    expect(uploadInit.method).toBe("PUT");
    expect(client.setTracklist).toHaveBeenCalledWith(
      501,
      [
        expect.objectContaining({
          title: "Northline",
          audioFileKey: "audio/501/master.wav",
          artists: [{ name: "Ada Voss", role: ["primary"] }],
        }),
      ],
    );
    expect(client.submitRelease).toHaveBeenCalledWith(
      501,
      expect.objectContaining({ acceptTerms: true, confirmRights: true }),
    );
    expect(spendRpcMock).toHaveBeenCalledTimes(1);
    expect(spendRpcMock).toHaveBeenCalledWith(
      "spend_hybrid_tokens",
      expect.objectContaining({
        _user_id: SESSION_USER,
        _amount: 1,
        _note: "Too Lost distribution",
      }),
    );
    const spendArgs = spendRpcMock.mock.calls[0][1] as { _user_id: string };
    expect(spendArgs._user_id).toBe(SESSION_USER);
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
    expect(spendRpcMock).not.toHaveBeenCalled();
  });
});
