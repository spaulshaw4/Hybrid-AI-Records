import { describe, expect, it } from "vitest";
import { generateSchema, parseGenerateEngineTrackInput } from "@/lib/generate-schema";
import { explainEngineFailure } from "@/lib/engine-failure";
import {
  LYRICS_SCHEMA_MESSAGE,
  LYRICS_TOO_LONG_MESSAGE,
  formatValidationError,
} from "@/lib/validation-error";

const prompt = "n".repeat(50);

describe("lyrics length validation", () => {
  it("accepts 5000 characters and rejects 5001 with a readable message", () => {
    const accepted = generateSchema.safeParse({ prompt, lyrics: "a".repeat(5000) });
    expect(accepted.success).toBe(true);

    const rejected = generateSchema.safeParse({ prompt, lyrics: "b".repeat(5001) });
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error.issues[0]?.message).toBe(LYRICS_SCHEMA_MESSAGE);
      expect(formatValidationError(rejected.error)).toBe(LYRICS_TOO_LONG_MESSAGE);
      expect(formatValidationError(rejected.error.message)).toBe(LYRICS_TOO_LONG_MESSAGE);
      expect(rejected.error.message).toContain("too_big");
    }

    expect(() => parseGenerateEngineTrackInput({ prompt, lyrics: "c".repeat(5001) })).toThrow(
      LYRICS_TOO_LONG_MESSAGE,
    );
  });

  it("does not render a too_big JSON payload as raw JSON", () => {
    const payload = JSON.stringify([
      {
        origin: "string",
        code: "too_big",
        maximum: 2000,
        inclusive: true,
        path: ["lyrics"],
        message: "Too big: expected string to have <=2000 characters",
      },
    ]);

    const shown = formatValidationError({ detail: payload });
    expect(shown).toBe(LYRICS_TOO_LONG_MESSAGE);
    expect(shown).not.toContain("too_big");
    expect(shown).not.toContain("origin");
    expect(shown.trim().startsWith("[")).toBe(false);

    const explained = explainEngineFailure(payload);
    expect(explained.message).toContain(LYRICS_TOO_LONG_MESSAGE);
    expect(explained.message).not.toContain("too_big");
    expect(explained.message).not.toContain('"origin"');

    const pydantic = {
      detail: [
        {
          type: "string_too_long",
          loc: ["body", "lyrics"],
          msg: "String should have at most 5000 characters",
          input: "x".repeat(5001),
          ctx: { max_length: 5000 },
        },
      ],
    };
    const fromApi = formatValidationError(pydantic);
    expect(fromApi).toBe(LYRICS_TOO_LONG_MESSAGE);
    expect(fromApi).not.toContain("string_too_long");
    expect(fromApi).not.toContain("max_length");
  });

  it("keeps other validation errors as a field message", () => {
    const shown = formatValidationError([
      {
        origin: "string",
        code: "too_big",
        maximum: 120,
        path: ["title"],
        message: "Too big: expected string to have <=120 characters",
      },
    ]);
    expect(shown).toBe("Too big: expected string to have <=120 characters");
    expect(shown).not.toContain("origin");
    expect(shown).not.toContain("too_big");
    expect(shown.trim().startsWith("[")).toBe(false);
  });
});
