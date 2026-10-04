import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesLookLikeHtml, proxyLovableAsset } from "@/lib/lovable-asset-proxy.server";

const BLOOMS =
  "/__l5e/assets-v1/f849d898-37bd-4c6b-b111-e6848d56623a/Blooms_Into_Madness.mp3";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lovable asset proxy", () => {
  it("forwards a byte range and returns audio, not HTML", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://hybrid-ai-studio.lovable.app${BLOOMS}`);
      expect(new Headers(init?.headers).get("range")).toBe("bytes=0-1");
      return new Response(new Uint8Array([0x49, 0x44]), {
        status: 206,
        headers: {
          "content-type": "audio/mpeg",
          "content-range": "bytes 0-1/4000000",
          "content-length": "2",
          "accept-ranges": "bytes",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyLovableAsset(
      new Request(`http://127.0.0.1:8080${BLOOMS}`, { headers: { range: "bytes=0-1" } }),
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(206);
    expect(response?.headers.get("content-type")).toBe("audio/mpeg");
    expect(response?.headers.get("accept-ranges")).toBe("bytes");
    expect(response?.headers.get("content-range")).toBe("bytes 0-1/4000000");

    const bytes = new Uint8Array(await response!.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("<!DOCTYPE")).toBe(false);
    expect(text.toLowerCase().startsWith("<html")).toBe(false);
    expect(bytesLookLikeHtml(bytes)).toBe(false);
    expect([...bytes]).toEqual([0x49, 0x44]);
  });

  it("does not pass an HTML SPA body through as audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!DOCTYPE html><html><body>missing</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );

    const response = await proxyLovableAsset(new Request(`http://127.0.0.1:8080${BLOOMS}`));
    expect(response?.status).toBe(502);
    expect(response?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await response!.text();
    expect(text.includes("<!DOCTYPE")).toBe(false);
    expect(text.toLowerCase().includes("<html")).toBe(false);
  });

  it("leaves unrelated paths alone", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await proxyLovableAsset(new Request("http://127.0.0.1:8080/radio"))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
