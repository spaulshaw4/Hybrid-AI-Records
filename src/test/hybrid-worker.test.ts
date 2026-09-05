import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HYBRID_WORKER_URL, hybridWorkerUrl } from "@/lib/hybrid-worker.server";

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
    process.env.HYBRID_WORKER_URL = "http://127.0.0.1:8000/";
    process.env.NODE_ENV = "production";
    expect(hybridWorkerUrl()).toBe("http://127.0.0.1:8000");
  });
});
