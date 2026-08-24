import { describe, expect, it } from "vitest";
import { GENERATE_SSE_KEEPALIVE_MS } from "@/lib/studio-generate-stream.server";

describe("studio generate SSE keep-alive", () => {
  it("pings keepalives often enough to defeat idle proxy closes", () => {
    expect(GENERATE_SSE_KEEPALIVE_MS).toBeLessThanOrEqual(30_000);
    expect(GENERATE_SSE_KEEPALIVE_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("keeps the client soft deadline at least 6 minutes", async () => {
    const mod = await import("@/lib/studio-generate-fetch");
    expect(mod.STUDIO_GENERATE_CLIENT_DEADLINE_MS).toBeGreaterThanOrEqual(6 * 60_000);
  });
});
