import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * API integrity guard.
 *
 * Locks the credential + endpoint contract of the render pipeline so a future
 * edit cannot silently reintroduce a managed-gateway route, an alias token, or
 * a credential leak into logs / user-facing copy.
 */

const read = (p: string) => readFileSync(p, "utf8");

const provider = read("src/lib/ai-provider.server.ts");
const validate = read("src/lib/replicate-validate.functions.ts");

describe("API integrity — credentials", () => {
  it("resolves every generation job from the platform Replicate token", () => {
    const matches = provider.match(/env\("REPLICATE_[A-Z_]+"\)/g) ?? [];
    const unique = [...new Set(matches)];
    expect(unique.sort()).toEqual([
      'env("REPLICATE_API_BASE_URL")',
      'env("REPLICATE_API_KEY")',
      'env("REPLICATE_API_TOKEN")',
    ]);
  });

  it("has no alias or platform-managed token fallbacks", () => {
    for (const alias of [
      "MUSIC_ENGINE_API_KEY",
      "LOVABLE_API_KEY",
      "ai.gateway",
      "x-connection-api-key",
    ]) {
      expect(provider).not.toContain(alias);
    }
  });

  it("defaults to the provider's own API endpoint", () => {
    expect(provider).toContain("https://api.replicate.com/v1");
  });

  it("sends bearer auth and JSON content type on every provider call", () => {
    expect(provider).toContain("Authorization: `Bearer ${replicateApiKey(label)}`");
    expect(provider).toContain('"Content-Type": "application/json"');
  });
});

describe("API integrity — validation logging", () => {
  it("never logs a provider response body verbatim", () => {
    expect(validate).not.toMatch(/console\.(error|log|warn)\([^)]*\$\{body\}/);
    expect(validate).toContain("bodyLength: body.length");
  });

  it("never returns the key value, only its shape", () => {
    expect(validate).toContain("key.slice(0, 3)");
    expect(validate).not.toMatch(/keyValue|return\s*{[^}]*\bkey\b\s*,/);
  });
});

describe("API integrity — verification messaging", () => {
  const messages = [...validate.matchAll(/message:\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1]!);

  it("produces user-facing messages for every outcome", () => {
    // unset key, rejected key, network error, success — plus the ternary branch.
    expect((validate.match(/message:/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("keeps messaging free of raw credential interpolation", () => {
    for (const message of messages) {
      expect(message).not.toContain("${key}");
      expect(message).not.toContain("r8_V");
    }
  });

  it("tells the operator what to do when the token is wrong", () => {
    expect(validate).toMatch(/Replace it with a raw token|save it in the secure form/);
  });
});
