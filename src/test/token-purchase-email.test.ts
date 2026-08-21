import { afterEach, describe, expect, it, vi } from "vitest";

import { sendTokenPurchaseEmail } from "@/lib/resend.server";

const original = process.env.RESEND_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  if (original === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = original;
});

describe("sendTokenPurchaseEmail", () => {
  it("is a no-op when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendTokenPurchaseEmail({
      to: "artist@example.com",
      amount: 100,
      balance: 140,
      tokenKind: "hybrid",
    });
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(spy).toHaveBeenCalled();
  });

  it("refuses a recipient without an @", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const result = await sendTokenPurchaseEmail({
      to: "not-an-email",
      amount: 10,
      balance: 10,
      tokenKind: "v",
    });
    expect(result).toEqual({ ok: false, reason: "no_recipient" });
  });
});
