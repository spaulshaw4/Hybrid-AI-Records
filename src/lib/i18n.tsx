import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { translateTexts } from "@/lib/translate.functions";
import { getTranslationOverrides } from "@/lib/translation-overrides.functions";
import { applyGlossary } from "@/lib/translation-glossary";

import { setDisplayLocale } from "@/lib/pricing";
import { SettingsError } from "@/lib/settings-error";

/**
 * Whole-page translation layer.
 *
 * English is the source language written in the codebase. When a visitor picks
 * another language we walk the rendered DOM, translate every visible string
 * once, cache it in localStorage, and keep watching for new nodes (modals,
 * the radio console, route changes) so freshly rendered copy is translated too.
 */

export type LanguageCode =
  | "en" | "ha" | "yo" | "ig" | "fr" | "pt" | "ar" | "sw" | "lt";

export type LanguageInfo = {
  code: LanguageCode;
  /** Name in English (used in the prompt). */
  label: string;
  /** Name in its own language (shown in the picker). */
  native: string;
  /** Flag emoji shown in the picker. */
  flag: string;
  /** BCP-47 tag used to format numbers, prices and dates in this language. */
  locale: string;
  rtl?: boolean;
};

export const LANGUAGES: LanguageInfo[] = [
  { code: "en", label: "English", native: "English", flag: "🇺🇸", locale: "en-US" },
  { code: "pt", label: "Portuguese", native: "Português", flag: "🇵🇹", locale: "pt-PT" },
  { code: "lt", label: "Lithuanian", native: "Lietuvių", flag: "🇱🇹", locale: "lt-LT" },
  { code: "ha", label: "Hausa", native: "Hausa", flag: "🇳🇬", locale: "ha-NG" },
  { code: "yo", label: "Yoruba", native: "Yorùbá", flag: "🇳🇬", locale: "yo-NG" },
  { code: "ig", label: "Igbo", native: "Igbo", flag: "🇳🇬", locale: "ig-NG" },
  { code: "fr", label: "French", native: "Français", flag: "🇫🇷", locale: "fr-FR" },
  { code: "ar", label: "Arabic", native: "العربية", flag: "🇸🇦", locale: "ar-EG", rtl: true },
  { code: "sw", label: "Swahili", native: "Kiswahili", flag: "🇰🇪", locale: "sw-KE" },

];

export const DEFAULT_LANGUAGE: LanguageCode = "en";

const STORAGE_KEY = "har_language";
// v2: bumped to drop caches that hold pre-glossary machine translations.
const CACHE_PREFIX = "har_i18n_v2_";

/** One year, so the choice survives long gaps between visits. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;


export function languageInfo(code: LanguageCode): LanguageInfo {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

/** BCP-47 tag for a language, used for prices, numbers and dates. */
export function localeForLanguage(code: LanguageCode): string {
  return languageInfo(code).locale;
}

function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && LANGUAGES.some((l) => l.code === value);
}


/* ---------------------------------------------------------------- store -- */

type Status = "idle" | "translating" | "error";

let current: LanguageCode = DEFAULT_LANGUAGE;
let status: Status = "idle";
let statusMessage = "";
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function snapshot() {
  return `${current}|${status}|${statusMessage}`;
}

export function useLanguageState(): {
  language: LanguageCode;
  status: Status;
  message: string;
} {
  useSyncExternalStore(subscribe, snapshot, () => `${DEFAULT_LANGUAGE}|idle|`);
  return { language: current, status, message: statusMessage };
}

/**
 * Switches the site language.
 *
 * Throws a `SettingsError` for an unknown code, or when the browser blocked
 * both persistence paths (the language still applies for this session).
 */
export function setLanguage(code: LanguageCode) {
  if (!LANGUAGES.some((l) => l.code === code)) {
    throw new SettingsError(`"${String(code)}" is not a supported language.`);
  }
  if (code === current) return;
  current = code;
  // Keep money formatting (symbol placement, spacing, decimals) in step.
  setDisplayLocale(localeForLanguage(code));
  const persisted = persistLanguage(code);
  emit();
  if (!persisted) {
    throw new SettingsError(
      "Your browser blocked saving this language, so it will reset when you reload.",
      { applied: true },
    );
  }
}

/**
 * The choice is written to both a cookie and localStorage. The cookie is the
 * source of truth: it is shared across tabs, survives refreshes, and is sent
 * with the document request so the server can read it later if needed.
 * localStorage stays as a mirror for browsers where cookies are blocked.
 * Returns false when neither store accepted the value.
 */
export function persistLanguage(code: LanguageCode): boolean {
  let cookieOk = false;
  let storageOk = false;
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${STORAGE_KEY}=${code}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    cookieOk = document.cookie.includes(`${STORAGE_KEY}=${code}`);
  } catch {
    /* cookies blocked */
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
    storageOk = window.localStorage.getItem(STORAGE_KEY) === code;
  } catch {
    /* storage blocked — session-only language */
  }
  return cookieOk || storageOk;
}

function readCookieLanguage(): LanguageCode | null {
  try {
    const match = document.cookie
      .split("; ")
      .find((part) => part.startsWith(`${STORAGE_KEY}=`));
    const raw = match ? decodeURIComponent(match.slice(STORAGE_KEY.length + 1)) : null;
    if (isLanguageCode(raw)) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

function setStatus(next: Status, message = "") {
  status = next;
  statusMessage = message;
  emit();
}

function readStoredLanguage(): LanguageCode | null {
  const fromCookie = readCookieLanguage();
  if (fromCookie) return fromCookie;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguageCode(raw)) return raw;
  } catch {
    /* ignore */
  }
  return null;
}


/**
 * Best match between the browser's preferred languages and what we support.
 * Region tags are ignored ("pt-BR" -> "pt"), and anything unsupported falls
 * back to English, which is the source language of the site.
 */
export function detectBrowserLanguage(): LanguageCode {
  if (typeof navigator === "undefined") return DEFAULT_LANGUAGE;
  const preferred = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (isLanguageCode(base)) return base;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * The language to start in: an explicit earlier choice wins, otherwise we
 * auto-detect from the browser and remember it so the page does not flip
 * languages between visits.
 */
export function initialLanguage(): LanguageCode {
  return readStoredLanguage() ?? detectBrowserLanguage();
}


/* ---------------------------------------------------------------- cache -- */

function loadCache(code: LanguageCode): Map<string, string> {
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + code);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveCache(code: LanguageCode, cache: Map<string, string>) {
  try {
    window.localStorage.setItem(
      CACHE_PREFIX + code,
      JSON.stringify(Object.fromEntries(cache)),
    );
  } catch {
    /* quota — cache stays in memory for this session */
  }
}

/* ------------------------------------------------------------ overrides -- */

/**
 * Admin-authored copy always wins over machine translation. Overrides are
 * fetched once per language per session and merged into the cache before any
 * translation request goes out, so edited wording appears immediately and the
 * translation service is never asked for those strings.
 */
const overridesLoaded = new Set<LanguageCode>();

async function mergeOverrides(code: LanguageCode, cache: Map<string, string>) {
  if (overridesLoaded.has(code)) return;
  try {
    const rows = await getTranslationOverrides({ data: { language: code } });
    for (const row of rows) {
      if (row.sourceText && row.translatedText) cache.set(row.sourceText, row.translatedText);
    }
    overridesLoaded.add(code);
  } catch {
    /* offline or blocked — fall back to machine translation for this session */
  }
}

/** Lets the admin panel re-pull overrides after an edit without a reload. */
export function invalidateTranslationOverrides(code?: LanguageCode) {
  if (code) overridesLoaded.delete(code);
  else overridesLoaded.clear();
  try {
    for (const l of LANGUAGES) {
      if (!code || l.code === code) window.localStorage.removeItem(CACHE_PREFIX + l.code);
    }
  } catch {
    /* ignore */
  }
}

/**
 * English source strings this browser has already seen translated, gathered
 * from every per-language cache. The admin panel uses them as the catalogue of
 * page copy that can be overridden.
 */
export function knownSourceStrings(): string[] {
  const set = new Set<string>();
  try {
    for (const l of LANGUAGES) {
      const raw = window.localStorage.getItem(CACHE_PREFIX + l.code);
      if (!raw) continue;
      for (const key of Object.keys(JSON.parse(raw) as Record<string, string>)) {
        if (key.trim()) set.add(key.trim());
      }
    }
  } catch {
    /* storage blocked */
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * The cached translations this browser holds for one language, keyed by the
 * English source string. Used by the pre-publish translation audit page to
 * report missing or untranslated copy.
 */
export function cachedTranslationsFor(code: LanguageCode): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  return loadCache(code);
}

/** Visible English copy currently rendered on this page. */
export function visibleSourceStrings(): string[] {
  if (typeof document === "undefined") return [];
  const set = new Set<string>();
  for (const node of collectTextNodes(document.body)) {
    const value = (originalText.get(node) ?? node.nodeValue ?? "").trim();
    if (value) set.add(value);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}





/* ------------------------------------------------------------ DOM walk -- */

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "SVG", "CANVAS", "IFRAME",
]);

/** Strings with no letters (prices, times, symbols) never need translating. */
const HAS_LETTER = /\p{L}{2,}/u;

const originalText = new WeakMap<Text, string>();
const originalAttr = new WeakMap<Element, Record<string, string>>();

function shouldSkip(node: Node): boolean {
  let el = node.parentElement;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute("data-no-translate")) return true;
    if (el.isContentEditable) return true;
    el = el.parentElement;
  }
  return false;
}

function collectTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const value = originalText.get(text) ?? text.nodeValue ?? "";
    if (HAS_LETTER.test(value) && !shouldSkip(text)) out.push(text);
    node = walker.nextNode();
  }
  return out;
}

const ATTRS = ["placeholder", "aria-label", "title", "alt"];

function collectAttrTargets(root: HTMLElement): Array<{ el: Element; attr: string; value: string }> {
  const out: Array<{ el: Element; attr: string; value: string }> = [];
  const els = root.querySelectorAll<HTMLElement>("[placeholder],[aria-label],[title],[alt]");
  for (const el of Array.from(els)) {
    if (SKIP_TAGS.has(el.tagName) || el.closest("[data-no-translate]")) continue;
    const saved = originalAttr.get(el) ?? {};
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const value = saved[attr] ?? el.getAttribute(attr) ?? "";
      if (!HAS_LETTER.test(value)) continue;
      out.push({ el, attr, value });
    }
  }
  return out;
}

function restoreEnglish(root: HTMLElement) {
  for (const text of collectTextNodes(root)) {
    const original = originalText.get(text);
    try {
      if (original !== undefined && text.isConnected) text.nodeValue = original;
    } catch {
      /* node detached mid-pass */
    }
  }
  const els = root.querySelectorAll<HTMLElement>("[placeholder],[aria-label],[title],[alt]");
  for (const el of Array.from(els)) {
    const saved = originalAttr.get(el);
    if (!saved) continue;
    for (const [attr, value] of Object.entries(saved)) {
      try {
        el.setAttribute(attr, value);
      } catch {
        /* element detached mid-pass */
      }
    }
  }
}


function chunk(items: string[], maxItems = 60, maxChars = 5_000): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const item of items) {
    if (batch.length >= maxItems || chars + item.length > maxChars) {
      if (batch.length) batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += item.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Translates everything currently rendered under `root` into `code`,
 * reusing the per-language cache and only calling the service for new strings.
 */
async function translateDocument(root: HTMLElement, code: LanguageCode, cache: Map<string, string>) {
  const info = languageInfo(code);
  const nodes = collectTextNodes(root);
  const attrs = collectAttrTargets(root);

  const pending = new Set<string>();
  const nodeJobs: Array<{ node: Text; key: string; lead: string; trail: string }> = [];

  for (const node of nodes) {
    const original = originalText.get(node) ?? node.nodeValue ?? "";
    if (!originalText.has(node)) originalText.set(node, original);
    const lead = original.match(/^\s*/)?.[0] ?? "";
    const trail = original.match(/\s*$/)?.[0] ?? "";
    const key = original.trim();
    if (!key) continue;
    nodeJobs.push({ node, key, lead, trail });
    if (!cache.has(key)) pending.add(key);
  }

  for (const target of attrs) {
    const saved = originalAttr.get(target.el) ?? {};
    if (saved[target.attr] === undefined) {
      saved[target.attr] = target.value;
      originalAttr.set(target.el, saved);
    }
    const key = target.value.trim();
    if (key && !cache.has(key)) pending.add(key);
  }

  const apply = () => {
    for (const job of nodeJobs) {
      const translated = cache.get(job.key);
      if (!translated) continue;
      const next = job.lead + translated + job.trail;
      // Only write when it actually changes, otherwise the MutationObserver
      // that triggered this pass would fire again forever.
      // A node React has already detached throws a DOMException on iOS Safari;
      // swallow it so one stale node can never blank the page.
      try {
        if (job.node.isConnected && job.node.nodeValue !== next) job.node.nodeValue = next;
      } catch {
        /* node detached mid-pass */
      }
    }
    for (const target of attrs) {
      const translated = cache.get(target.value.trim());
      try {
        if (translated && target.el.isConnected && target.el.getAttribute(target.attr) !== translated) {
          target.el.setAttribute(target.attr, translated);
        }
      } catch {
        /* element detached mid-pass */
      }
    }
  };


  apply();
  if (pending.size === 0) return;

  setStatus("translating");
  let failed = "";
  for (const batch of chunk(Array.from(pending))) {
    if (current !== code) return; // visitor switched mid-flight
    const result = await translateTexts({
      data: { texts: batch, target: code, targetLabel: info.label },
    });
    if ("error" in result) {
      failed = result.error;
      break;
    }
    batch.forEach((source, i) => {
      const translated = result.texts[i];
      if (typeof translated === "string" && translated.trim()) cache.set(source, translated.trim());
    });
    if (current !== code) return;
    apply();
  }

  saveCache(code, cache);
  if (failed) setStatus("error", failed);
  else setStatus("idle");
}

/* ------------------------------------------------------------ provider -- */

/**
 * Mounted once at the app root. Watches the language store and keeps the
 * rendered page in sync with the chosen language.
 */
export function PageTranslator() {
  const { language } = useLanguageState();
  const cacheRef = useRef<Map<string, string> | null>(null);
  const runningRef = useRef(false);
  const queuedRef = useRef(false);

  // Saved choice, else browser auto-detect — after hydration, never during SSR.
  useEffect(() => {
    const initial = initialLanguage();
    if (initial !== current) setLanguage(initial);
    // Write it back even when it already matches, so English (the default)
    // and any localStorage-only value get a cookie for other tabs to read.
    else persistLanguage(initial);
  }, []);

  // Follow the choice when another tab switches language.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const next = event.newValue;
      if (isLanguageCode(next) && next !== current) setLanguage(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);



  const run = useCallback(async (code: LanguageCode) => {
    if (typeof document === "undefined") return;
    const root = document.body;
    if (code === DEFAULT_LANGUAGE) {
      restoreEnglish(root);
      setStatus("idle");
      return;
    }
    if (runningRef.current) {
      queuedRef.current = true;
      return;
    }
    runningRef.current = true;
    try {
      if (!cacheRef.current) cacheRef.current = loadCache(code);
      // Curated phrasing first, admin overrides last — both beat the machine.
      applyGlossary(code, cacheRef.current);
      await mergeOverrides(code, cacheRef.current);
      await translateDocument(root, code, cacheRef.current);
    } catch (error) {
      // Translation is cosmetic; never let it take the page down on iOS.
      console.error(error);
      setStatus("error", "Translation could not finish — showing the original text.");
    } finally {
      runningRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void run(current);
      }
    }
  }, []);

  useEffect(() => {
    const info = languageInfo(language);
    document.documentElement.lang = language;
    document.documentElement.dir = info.rtl ? "rtl" : "ltr";
    cacheRef.current = language === DEFAULT_LANGUAGE ? null : loadCache(language);
    void run(language);
  }, [language, run]);

  // New copy appears constantly (modals, radio queue, route changes).
  useEffect(() => {
    if (language === DEFAULT_LANGUAGE) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver((records) => {
      if (document.visibilityState === "hidden") return;
      const relevant = records.some((record) => {
        const node = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!node) return true;
        if (node.closest?.(".living-bg, [data-radio-progress]")) return false;
        return true;
      });
      if (!relevant) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(language), 400);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [language, run]);

  return null;
}
