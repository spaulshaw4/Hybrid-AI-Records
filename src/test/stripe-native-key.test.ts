import { afterEach, describe, expect, it } from "vitest";

import { nativeStripeSecret } from "@/lib/stripe.server";

const NAMES = [
  "sk_live",
  "sk_test",
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_LIVE_SECRET_KEY",
  "STRIPE_TEST_SECRET_KEY",
] as const;

describe("nativeStripeSecret", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const name of NAMES) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function snapshotEnv() {
    for (const name of NAMES) saved[name] = process.env[name];
    for (const name of NAMES) delete process.env[name];
  }

  it("reads the sk_live alias for a live restricted key", () => {
    snapshotEnv();
    process.env.sk_live = "rk_live_placeholder";
    expect(nativeStripeSecret("live")).toBe("rk_live_placeholder");
  });

  it("reads STRIPE_SECRET_KEY when sk_live is unset", () => {
    snapshotEnv();
    process.env.STRIPE_SECRET_KEY = "sk_live_placeholder";
    expect(nativeStripeSecret("live")).toBe("sk_live_placeholder");
  });

  it("does not treat a live secret as a sandbox key", () => {
    snapshotEnv();
    process.env.STRIPE_SECRET_KEY = "sk_live_placeholder";
    expect(nativeStripeSecret("sandbox")).toBeUndefined();
  });
});
