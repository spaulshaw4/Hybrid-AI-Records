import { describe, expect, it, afterEach } from "vitest";
import { formatAmount, setDisplayLocale, CURRENCY_CODES } from "@/lib/pricing";

afterEach(() => setDisplayLocale(null));

describe("language-aware money formatting", () => {
  it("places the symbol per language, not per currency", () => {
    expect(formatAmount(4500, "eur", { locale: "en-US" })).toBe("€45");
    expect(formatAmount(4500, "eur", { locale: "pt-PT" })).toMatch(/45\s?€/);
    expect(formatAmount(4500, "eur", { locale: "lt-LT" })).toMatch(/45\s?€/);
  });

  it("follows the active display locale when none is passed", () => {
    setDisplayLocale("fr-FR");
    expect(formatAmount(4500, "eur")).toMatch(/45\s?€/);
  });

  it("keeps Latin digits in Arabic", () => {
    expect(formatAmount(4500, "eur", { locale: "ar-EG" })).toMatch(/45/);
  });

  it("hides decimals on whole amounts and shows two otherwise", () => {
    for (const code of CURRENCY_CODES) {
      expect(formatAmount(5000, code, { locale: "en-US" })).not.toMatch(/[.,]\d\d/);
      expect(formatAmount(5099, code, { locale: "en-US" })).toMatch(/[.,]99/);
    }
  });
});
