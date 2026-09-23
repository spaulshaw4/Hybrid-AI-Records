import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HYBRID_WORKER_URL,
  canonicalizeWorkerUrl,
  hybridWorkerUrl,
} from "@/lib/hybrid-worker.server";
import { proxyToHybridWorker } from "@/lib/hybrid-worker-proxy.server";

describe("hybridWorkerUrl", () => {
  const originalWorker = process.env.HYBRID_WORKER_URL;
  const originalVite = process.env.VITE_HYBRID_WORKER_URL;
  const originalNode = process.env.NODE_ENV;

  afterEach(() => {
    if (originalWorker === undefined) delete process.env.HYBRID_WORKER_URL;
    else process.env.HYBRID_WORKER_URL = originalWorker;
    if (originalVite === undefined) delete process.env.VITE_HYBRID_WORKER_URL;
    else process.env.VITE_HYBRID_WORKER_URL = originalVite;
    process.env.NODE_ENV = originalNode;
  });

  it("defaults to the local Worker port outside production", () => {
    delete process.env.HYBRID_WORKER_URL;
    delete process.env.VITE_HYBRID_WORKER_URL;
    process.env.NODE_ENV = "development";
    expect(hybridWorkerUrl()).toBe(DEFAULT_HYBRID_WORKER_URL);
  });

  it("stays off in production unless explicitly set", () => {
    delete process.env.HYBRID_WORKER_URL;
    delete process.env.VITE_HYBRID_WORKER_URL;
    process.env.NODE_ENV = "production";
    expect(hybridWorkerUrl()).toBeNull();
  });

  it("honors HYBRID_WORKER_URL=off", () => {
    process.env.HYBRID_WORKER_URL = "off";
    process.env.NODE_ENV = "development";
    expect(hybridWorkerUrl()).toBeNull();
  });

  it("uses an explicit workstation URL in production", () => {
    process.env.HYBRID_WORKER_URL = "http://127.0.0.1:8880/";
    process.env.NODE_ENV = "production";
    expect(hybridWorkerUrl()).toBe("http://127.0.0.1:8880");
  });

  it("rewrites a frontend or legacy worker port to FastAPI on 8880", () => {
    expect(canonicalizeWorkerUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:8880");
    expect(canonicalizeWorkerUrl("http://localhost:8080/")).toBe("http://localhost:8880");
    expect(canonicalizeWorkerUrl("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8880");
    process.env.HYBRID_WORKER_URL = "http://127.0.0.1:3000";
    process.env.NODE_ENV = "development";
    expect(hybridWorkerUrl()).toBe("http://127.0.0.1:8880");
  });

  it("does not rewrite a non-loopback frontend port", () => {
    expect(canonicalizeWorkerUrl("https://example.com:3000")).toBe("https://example.com:3000");
  });
});

describe("proxyToHybridWorker", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("forwards POST /generate to the FastAPI worker on :8880", async () => {
    delete process.env.HYBRID_WORKER_URL;
    delete process.env.VITE_HYBRID_WORKER_URL;
    process.env.NODE_ENV = "development";
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ session_id: "ht_proxy", status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const request = new Request("http://127.0.0.1:8080/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "bridge" }),
    });
    const response = await proxyToHybridWorker(request, "/generate");
    expect(response.status).toBe(200);
    expect(calls[0]).toBe("http://127.0.0.1:8880/generate");
    expect(response.headers.get("x-hybrid-worker-upstream")).toBe(
      "http://127.0.0.1:8880/generate",
    );
  });
});
