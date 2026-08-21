import { describe, expect, it, beforeEach } from "vitest";
import {
  parseTermsAccepted,
  readStoredVocalConsent,
  writeStoredVocalConsent,
  VOCAL_LIABILITY_SESSION_KEY,
} from "@/lib/vocal-consent";

describe("parseTermsAccepted", () => {
  it("accepts true, 1, and common form strings", () => {
    expect(parseTermsAccepted(true)).toBe(true);
    expect(parseTermsAccepted(1)).toBe(true);
    expect(parseTermsAccepted("true")).toBe(true);
    expect(parseTermsAccepted("ON")).toBe(true);
    expect(parseTermsAccepted("yes")).toBe(true);
  });

  it("rejects missing or false flags", () => {
    expect(parseTermsAccepted(false)).toBe(false);
    expect(parseTermsAccepted(null)).toBe(false);
    expect(parseTermsAccepted("")).toBe(false);
    expect(parseTermsAccepted("false")).toBe(false);
  });
});

describe("session vocal liability", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("reads vocal_liability_accepted from sessionStorage", () => {
    expect(readStoredVocalConsent()).toBe(false);
    sessionStorage.setItem(VOCAL_LIABILITY_SESSION_KEY, "true");
    expect(readStoredVocalConsent()).toBe(true);
  });

  it("writes the session flag used by the record/upload gate", () => {
    writeStoredVocalConsent(true);
    expect(sessionStorage.getItem("vocal_liability_accepted")).toBe("true");
    writeStoredVocalConsent(false);
    expect(sessionStorage.getItem("vocal_liability_accepted")).toBeNull();
  });
});
