/**
 * Server-only progress bridge for SSE generate streams.
 * Keeps AsyncLocalStorage out of the browser-safe pipeline-progress module.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { StudioProgressCallback } from "@/lib/pipeline-progress";

const progressAls = new AsyncLocalStorage<StudioProgressCallback>();

declare global {
  // eslint-disable-next-line no-var
  var __hybridPipelineProgressAls:
    | { getStore: () => StudioProgressCallback | undefined }
    | undefined;
}

globalThis.__hybridPipelineProgressAls = {
  getStore: () => progressAls.getStore(),
};

export function runWithPipelineProgressCallback<T>(
  onProgress: StudioProgressCallback,
  work: () => Promise<T>,
): Promise<T> {
  return progressAls.run(onProgress, work);
}
