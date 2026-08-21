import { describe, expect, it } from "vitest";
import {
  MIN_FILL_MS,
  MAX_SUBMITS_PER_HOUR,
  SUBMIT_COOLDOWN_MS,
  checkArtistName,
  checkBotSignals,
  checkEmail,
  checkLink,
  checkNotes,
} from "@/lib/form-guard";

const NOW = 1_700_000_000_000;

describe("field validation", () => {
  it("accepts a real artist name", () => {
    expect(checkArtistName("Sage Zimba")).toBeNull();
  });
  it.each(["A", "https://spam.example", "<script>", "!!!!", "aaaaaaaaaa"])(
    "rejects %s",
    (value) => {
      expect(checkArtistName(value)).not.toBeNull();
    },
  );

  it("accepts a normal email", () => {
    expect(checkEmail("artist@gmail.com")).toBeNull();
  });
  it.each(["", "nope", "a@b", "a@b..com", "a@b.c", "user@mailinator.com"])(
    "rejects email %s",
    (value) => {
      expect(checkEmail(value)).not.toBeNull();
    },
  );

  it("allows an empty link and public https links", () => {
    expect(checkLink("")).toBeNull();
    expect(checkLink("https://drive.google.com/file/abc")).toBeNull();
  });
  it.each(["javascript:alert(1)", "drive.google.com", "http://localhost:8080/x"])(
    "rejects link %s",
    (value) => {
      expect(checkLink(value)).not.toBeNull();
    },
  );

  it("passes normal notes but flags spam", () => {
    expect(checkNotes("Rock track, needs mixing before June.")).toBeNull();
    expect(checkNotes("Cheap SEO service for your site")).not.toBeNull();
    expect(
      checkNotes("https://a.com https://b.com https://c.com https://d.com"),
    ).not.toBeNull();
    expect(checkNotes("BUY MY ALBUM RIGHT NOW IT IS THE GREATEST EVER MADE OK")).not.toBeNull();
  });
});

describe("bot signals", () => {
  const base = { honeypot: "", startedAt: NOW - 60_000, now: NOW, history: [] as number[] };

  it("lets a normal human submission through", () => {
    expect(checkBotSignals(base).ok).toBe(true);
  });

  it("blocks a filled honeypot", () => {
    const v = checkBotSignals({ ...base, honeypot: "http://spam" });
    expect(v).toMatchObject({ ok: false, reason: "honeypot" });
  });

  it("blocks submissions faster than a human can type", () => {
    const v = checkBotSignals({ ...base, startedAt: NOW - (MIN_FILL_MS - 1000) });
    expect(v).toMatchObject({ ok: false, reason: "too-fast" });
  });

  it("enforces the cooldown between submissions", () => {
    const v = checkBotSignals({ ...base, history: [NOW - (SUBMIT_COOLDOWN_MS - 5_000)] });
    expect(v).toMatchObject({ ok: false, reason: "cooldown" });
  });

  it("allows a resubmission once the cooldown has passed", () => {
    expect(checkBotSignals({ ...base, history: [NOW - (SUBMIT_COOLDOWN_MS + 1_000)] }).ok).toBe(
      true,
    );
  });

  it("rate-limits floods within the hour", () => {
    const history = Array.from(
      { length: MAX_SUBMITS_PER_HOUR },
      (_, i) => NOW - (i + 1) * 5 * 60_000,
    );
    expect(checkBotSignals({ ...base, history })).toMatchObject({
      ok: false,
      reason: "rate-limit",
    });
  });

  it("ignores submissions older than an hour", () => {
    expect(checkBotSignals({ ...base, history: [NOW - 2 * 60 * 60_000] }).ok).toBe(true);
  });
});
