import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForVaultedTrack } from "@/lib/wavespeed-track-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("waitForVaultedTrack", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the vault urls once the webhook status is completed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(String(url)).toContain("/api/ai/wavespeed-webhook?taskId=task-9");
        calls += 1;
        if (calls === 1) return jsonResponse({ status: "processing", taskId: "task-9" });
        return jsonResponse({
          status: "completed",
          wavUrl: "https://project.supabase.co/masters/task-9.wav",
          mp3Url: "https://project.supabase.co/masters/task-9.mp3",
        });
      }),
    );

    const pending = waitForVaultedTrack("task-9");
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toEqual({
      wavUrl: "https://project.supabase.co/masters/task-9.wav",
      mp3Url: "https://project.supabase.co/masters/task-9.mp3",
    });
  });

  it("surfaces an upstream failure without waiting out the ceiling", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "failed", error: "Generation failed upstream" })),
    );

    const pending = waitForVaultedTrack("task-1");
    const expectation = expect(pending).rejects.toThrow("Generation failed upstream");
    await vi.advanceTimersByTimeAsync(3000);
    await expectation;
  });

  it("throws the engine ceiling after 120 status polls", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ status: "processing" });
      }),
    );

    const pending = waitForVaultedTrack("task-4");
    const expectation = expect(pending).rejects.toThrow("Task hit the 6-minute engine ceiling");
    for (let attempt = 0; attempt < 120; attempt++) {
      await vi.advanceTimersByTimeAsync(3000);
    }
    await expectation;
    expect(calls).toBe(120);
  });
});
