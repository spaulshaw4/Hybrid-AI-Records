import { describe, it, expect, afterEach } from "vitest";
import { applyFxRates, convertFromUsd, resetFxRates, isPlausibleRate } from "@/lib/fx";
import { basePriceFor, amountFor, surchargeAmountFor } from "@/lib/pricing";

const fresh = (rate: number) => ({
  rate,
  fetchedAt: new Date().toISOString(),
  source: "test",
});

afterEach(() => resetFxRates());

describe("live FX conversion", () => {
  it("converts USD into tidy local increments", () => {
    applyFxRates({ zar: fresh(18), eur: fresh(0.9), ngn: fresh(1500) });
    // $50 -> R900 exactly, already on the R10 step
    expect(convertFromUsd(5000, "zar")).toBe(90_000);
    // $50 -> €45
    expect(convertFromUsd(5000, "eur")).toBe(4_500);
    // $50 -> ₦75,000 rounded up to the nearest ₦1,000
    expect(convertFromUsd(5000, "ngn")).toBe(7_500_000);
  });

  it("rounds up, never down, so we are never under-charged", () => {
    applyFxRates({ eur: fresh(0.8712) });
    expect(convertFromUsd(5000, "eur")).toBe(4_400); // €43.56 -> €44
  });

  it("ignores stale and implausible quotes", () => {
    const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    applyFxRates({
      eur: { rate: 0.9, fetchedAt: old, source: "test" },
      zar: fresh(0.0001),
    });
    expect(convertFromUsd(5000, "eur")).toBeNull();
    expect(convertFromUsd(5000, "zar")).toBeNull();
    expect(isPlausibleRate("zar", 0.0001)).toBe(false);
  });

  it("falls back to published local prices when no rate is loaded", () => {
    resetFxRates();
    const published = basePriceFor("foundation_song_onetime", "zar");
    expect(published).toBeGreaterThan(0);
    expect(convertFromUsd(5000, "zar")).toBeNull();
  });

  it("keeps base + 2% fee equal to the charged total at live rates", () => {
    applyFxRates({ zar: fresh(18.37) });
    const base = basePriceFor("foundation_song_onetime", "zar")!;
    const fee = surchargeAmountFor("foundation_song_onetime", "zar")!;
    const total = amountFor("foundation_song_onetime", "zar")!;
    expect(base + fee).toBe(total);
    expect(fee).toBe(Math.ceil((base * 10_200) / 10_000) - base);
  });

  it("leaves USD untouched", () => {
    applyFxRates({ eur: fresh(0.9) });
    expect(convertFromUsd(5000, "usd")).toBe(5000);
    expect(surchargeAmountFor("foundation_song_onetime", "usd")).toBe(0);
  });
});
