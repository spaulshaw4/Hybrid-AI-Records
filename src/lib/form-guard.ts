/**
 * Shared, dependency-free spam / bot heuristics for the artist application
 * forms. Pure functions only, so the same rules run in the browser and inside
 * server functions (a bot that skips the UI still hits the same checks).
 */

/** Bots fill every field they find, including ones humans never see. */
export const HONEYPOT_FIELD = "company_website";

/** A real person cannot read and complete the form faster than this. */
export const MIN_FILL_MS = 4_000;

/** Minimum gap between two submissions from the same device. */
export const SUBMIT_COOLDOWN_MS = 30_000;

/** Max submissions allowed from one device per rolling hour. */
export const MAX_SUBMITS_PER_HOUR = 5;

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "yopmail.com",
  "trashmail.com",
  "sharklasers.com",
  "getnada.com",
  "dispostable.com",
  "fakeinbox.com",
  "maildrop.cc",
  "mailnesia.com",
  "spam4.me",
  "tempr.email",
  "moakt.com",
  "emailondeck.com",
]);

const SPAM_PHRASES = [
  "seo service",
  "buy followers",
  "casino",
  "crypto investment",
  "forex",
  "viagra",
  "cialis",
  "loan offer",
  "make money fast",
  "work from home",
  "click here now",
  "telegram @",
  "whatsapp +",
  "bit.ly/",
  "porn",
  "escort",
];

const URL_RE = /(https?:\/\/|www\.)\S+/gi;

/* ------------------------------ field rules ------------------------------ */

/** Names are people/bands — never URLs, markup, or control characters. */
export function checkArtistName(value: string): string | null {
  const v = value.trim();
  if (v.length < 2) return "Enter your full artist or band name (at least 2 characters).";
  if (URL_RE.test(v)) {
    URL_RE.lastIndex = 0;
    return "Artist name can't contain a web address. Put links in the External Link field.";
  }
  if (/[<>{}]|&#|script:/i.test(v)) return "Artist name can't contain code or markup characters.";
  if (!/[\p{L}\p{N}]/u.test(v)) return "Artist name must include at least one letter or number.";
  if (/(.)\1{6,}/.test(v)) return "That artist name looks like repeated characters. Please check it.";
  return null;
}

/** Stricter than a plain email regex: blocks disposable and malformed hosts. */
export function checkEmail(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return "Enter your email address.";
  if (!/^[^\s@,;"'<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) {
    return "Enter a valid email address, e.g. you@example.com.";
  }
  const domain = v.split("@")[1] ?? "";
  if (domain.endsWith(".") || domain.includes("..")) return "That email domain looks incomplete.";
  const tld = domain.split(".").pop() ?? "";
  if (tld.length < 2) return "That email domain looks incomplete.";
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return "Please use a permanent email address — disposable inboxes can't receive your contract.";
  }
  return null;
}

/** Only real http(s) links to a public host are accepted. */
export function checkLink(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > 500) return "Link must be under 500 characters.";
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return "Enter a full URL starting with https:// (for example https://drive.google.com/…).";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "Only https:// links are accepted.";
  }
  if (!url.hostname.includes(".") || url.hostname.endsWith(".")) {
    return "That link's web address looks incomplete.";
  }
  if (/^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/i.test(url.hostname)) {
    return "That link only works on your own network. Paste a public share link instead.";
  }
  return null;
}

/** Flags obvious marketing spam pasted into the free-text notes field. */
export function checkNotes(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > 2000) return "Notes must be under 2000 characters.";
  const lower = v.toLowerCase();
  const links = v.match(URL_RE)?.length ?? 0;
  if (links > 3) {
    return "That's a lot of links. Keep it to the three most relevant ones.";
  }
  if (SPAM_PHRASES.some((p) => lower.includes(p))) {
    return "Your notes were flagged as promotional content. Please describe your project instead.";
  }
  const letters = v.replace(/[^a-z]/gi, "");
  if (letters.length > 40 && letters === letters.toUpperCase()) {
    return "Please don't write in all capitals — it reads as spam to our filters.";
  }
  return null;
}

/* ---------------------------- bot-level checks ---------------------------- */

export type GuardInput = {
  honeypot: string;
  /** Epoch ms when the form was first shown to the visitor. */
  startedAt: number;
  now?: number;
  /** Epoch ms timestamps of earlier submissions from this device. */
  history?: number[];
};

export type GuardVerdict = { ok: true } | { ok: false; reason: string; message: string };

export function checkBotSignals(input: GuardInput): GuardVerdict {
  const now = input.now ?? Date.now();

  if (input.honeypot.trim() !== "") {
    return {
      ok: false,
      reason: "honeypot",
      message:
        "This submission was blocked by our spam filter. If you're a person, reload the page and try again.",
    };
  }

  const elapsed = now - input.startedAt;
  if (input.startedAt > 0 && elapsed < MIN_FILL_MS) {
    const wait = Math.ceil((MIN_FILL_MS - elapsed) / 1000);
    return {
      ok: false,
      reason: "too-fast",
      message: `That was submitted unusually fast. Take another ${wait} second${wait === 1 ? "" : "s"} to review your details, then submit again.`,
    };
  }

  const history = (input.history ?? []).filter((t) => now - t < 60 * 60 * 1000);
  const last = history.length ? Math.max(...history) : 0;
  if (last && now - last < SUBMIT_COOLDOWN_MS) {
    const wait = Math.ceil((SUBMIT_COOLDOWN_MS - (now - last)) / 1000);
    return {
      ok: false,
      reason: "cooldown",
      message: `You just submitted an application. Please wait ${wait} second${wait === 1 ? "" : "s"} before sending another.`,
    };
  }
  if (history.length >= MAX_SUBMITS_PER_HOUR) {
    return {
      ok: false,
      reason: "rate-limit",
      message: `You've sent ${MAX_SUBMITS_PER_HOUR} applications in the last hour. Please email Hybrid.AI.Records@proton.me instead of submitting more.`,
    };
  }

  return { ok: true };
}

/* --------------------------- device-side history -------------------------- */

const HISTORY_KEY = "har:application-submits";

export function readSubmitHistory(): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((n): n is number => typeof n === "number" && now - n < 60 * 60 * 1000);
  } catch {
    return [];
  }
}

export function recordSubmit(at: number = Date.now()): void {
  if (typeof window === "undefined") return;
  try {
    const next = [...readSubmitHistory(), at].slice(-MAX_SUBMITS_PER_HOUR * 2);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled — the server-side checks still apply.
  }
}
