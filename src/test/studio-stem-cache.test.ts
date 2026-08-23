import { describe, expect, it } from "vitest";
import { STEM_CACHE_KEY_PREFIX, studioStemCacheKey } from "@/lib/studio-stem-cache";

describe("studio stem cache keys", () => {
  it("stores blobs under studio_stems_${taskId}", () => {
    expect(studioStemCacheKey("task-55")).toBe(`${STEM_CACHE_KEY_PREFIX}task-55`);
    expect(studioStemCacheKey("task-55")).toBe("studio_stems_task-55");
  });
});
