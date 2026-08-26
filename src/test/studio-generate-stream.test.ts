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

  it("starts synthesis before the stream controller so cancel cannot kill the job", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const src = await readFile(
      join(process.cwd(), "src/lib/studio-generate-stream.server.ts"),
      "utf8",
    );
    expect(src).toMatch(/jobPromise = runWithPipelineProgressCallback/);
    expect(src).toMatch(/sseSendAls\.run/);
    expect(src).toMatch(/cancel\(\)/);
    expect(src).toMatch(/synthesis continues/);
    expect(src).toMatch(/do NOT abort jobPromise/i);
  });

  it("exposes emitGenerateSseEvent for mid-flight task ids", async () => {
    const mod = await import("@/lib/studio-generate-stream.server");
    expect(typeof mod.emitGenerateSseEvent).toBe("function");
  });

  it("registers pending vault with provider task id immediately after create", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const src = await readFile(
      join(process.cwd(), "src/lib/apiframe-music.functions.ts"),
      "utf8",
    );
    expect(src).toMatch(/providerTaskId:\s*started\.taskId/);
    expect(src).toMatch(/\[Composition\] Audio URL received -> Writing to user_vault/);
    expect(src).toMatch(/\[Composition\] Marking user_vault failed/);
    expect(src).toMatch(/emitGenerateSseEvent\("task"/);
    expect(src).toMatch(/COMPOSITION_POLL_TIMEOUT_MS/);
  });
});
