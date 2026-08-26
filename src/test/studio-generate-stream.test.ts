import { describe, expect, it } from "vitest";
import { GENERATE_SSE_KEEPALIVE_MS } from "@/lib/studio-generate-stream.server";

describe("studio generate SSE keep-alive", () => {
  it("pings keepalives often enough to defeat idle proxy closes", () => {
    expect(GENERATE_SSE_KEEPALIVE_MS).toBeLessThanOrEqual(30_000);
    expect(GENERATE_SSE_KEEPALIVE_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("keeps the client soft deadline at 6 minutes", async () => {
    const mod = await import("@/lib/studio-generate-fetch");
    expect(mod.STUDIO_GENERATE_CLIENT_DEADLINE_MS).toBe(6 * 60_000);
  });

  it("aligns vault poll window to 6 minutes / 4s", async () => {
    const vault = await import("@/lib/vault-client");
    expect(vault.VAULT_POLL_MS).toBe(4_000);
    expect(vault.VAULT_POLL_MAX_MS).toBe(360_000);
  });
});
