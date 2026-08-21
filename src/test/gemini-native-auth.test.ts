import { afterEach, describe, expect, it } from "vitest";

import {
  geminiGenerateContentUrl,
  geminiNativeHeaders,
} from "@/lib/ai-provider.server";

const originalPaidKey = process.env.GOOGLE_PAID_API_KEY;

afterEach(() => {
  if (originalPaidKey === undefined) delete process.env.GOOGLE_PAID_API_KEY;
  else process.env.GOOGLE_PAID_API_KEY = originalPaidKey;
});

describe("native Gemini authentication", () => {
  it("uses a query-string API key and never sends Authorization", () => {
    process.env.GOOGLE_PAID_API_KEY = "test-paid-key";

    const url = geminiGenerateContentUrl(
      "google/gemini-2.5-flash-lite",
      "Character assistant",
      "paid",
    );
    const headers = geminiNativeHeaders();

    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=test-paid-key",
    );
    expect(headers).toEqual({ "Content-Type": "application/json" });
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("x-goog-api-key");
  });
});