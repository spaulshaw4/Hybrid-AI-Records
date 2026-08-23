import { describe, expect, it } from "vitest";
import {
  GENERATION_ABORTED_MESSAGE,
  GenerationAbortedError,
  abortableDelay,
  isGenerationAborted,
  throwIfAborted,
} from "@/lib/generation-abort";

describe("generation abort", () => {
  it("throws a typed cancel error when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(GENERATION_ABORTED_MESSAGE);
  });

  it("rejects an abortable delay without treating it as an engine failure", async () => {
    const controller = new AbortController();
    const pending = abortableDelay(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(GenerationAbortedError);
    await expect(pending).rejects.toSatisfy((error) => isGenerationAborted(error));
  });
});
