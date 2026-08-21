/**
 * Shareable links into the quick order form.
 *
 * Every entry point (header CTA, package cards, WhatsApp follow-ups) should use
 * these helpers so the URL is always the same shape: `/?package=<slug>#order`,
 * or plain `/#order` when no package is preselected.
 */

export const ORDER_PACKAGES = [
  "Distribution & Release",
  "Production & Visual Push",
  "Full Label Release",
  "Standard Video Package",
  "4K HD Video Package",
] as const;

export type OrderPackage = (typeof ORDER_PACKAGES)[number];

/** URL-safe slug for each package label. */
export const PACKAGE_SLUGS: Record<OrderPackage, string> = {
  "Distribution & Release": "distribution-release",
  "Production & Visual Push": "visual-push",
  "Full Label Release": "full-label",
  "Standard Video Package": "standard-video",
  "4K HD Video Package": "4k-hd-video",
};

const SLUG_TO_PACKAGE = Object.fromEntries(
  Object.entries(PACKAGE_SLUGS).map(([label, slug]) => [slug, label as OrderPackage]),
) as Record<string, OrderPackage>;

/**
 * Older/alternate slugs that still point at a real package (the /start/$package
 * routes use these), so shared links keep working instead of silently failing.
 */
const SLUG_ALIASES: Record<string, OrderPackage> = {
  foundation: "Distribution & Release",
  "the-foundation": "Distribution & Release",
  distribution: "Distribution & Release",
  "the-visual-push": "Production & Visual Push",
  production: "Production & Visual Push",
  "full-hybrid": "Full Label Release",
  "full-hybrid-experience": "Full Label Release",
  "full-label-release": "Full Label Release",
  "standard-video-package": "Standard Video Package",
  video: "Standard Video Package",
  "4k-video": "4K HD Video Package",
  "4k-hd": "4K HD Video Package",
  "4k-hd-video-package": "4K HD Video Package",
};


/**
 * Resolves any user-supplied slug to a real package: exact match first, then a
 * normalized (lowercased, trimmed, de-spaced) match, then a known alias.
 * Returns null for anything unrecognized.
 */
/**
 * Legacy share links (generated before the copy button encoded values once)
 * are double-encoded: `Sol%2520Vega` arrives from URLSearchParams as
 * `Sol%20Vega`. If a once-decoded value still carries valid percent-escapes,
 * decode it one more time so those old links restore real values.
 */
export function decodeLegacyValue(raw: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try {
    const once = decodeURIComponent(raw);
    return /%[0-9A-Fa-f]{2}/.test(once) ? raw : once;
  } catch {
    return raw;
  }
}

export function resolvePackageSlug(input: string | null | undefined): OrderPackage | null {
  if (!input) return null;
  const raw = decodeLegacyValue(input);
  if (SLUG_TO_PACKAGE[raw]) return SLUG_TO_PACKAGE[raw];
  const normalized = raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  if (!normalized) return null;
  return SLUG_TO_PACKAGE[normalized] ?? SLUG_ALIASES[normalized] ?? null;
}


/** Free-text details that can ride along in a shared order link. */
export type OrderPrefill = {
  artist?: string | null;
  email?: string | null;
  link?: string | null;
};

/** Query-param names for each prefillable field. */
const PREFILL_PARAMS = {
  artist: "artist",
  email: "email",
  link: "demo",
} as const;

/** Hard caps mirroring the form's own validation. */
const PREFILL_MAX = { artist: 200, email: 255, link: 600 } as const;

function cleanValue(field: keyof typeof PREFILL_MAX, input: string | null | undefined) {
  if (!input) return "";
  const raw = decodeLegacyValue(input);
  // Strip control characters, collapse whitespace, and enforce the field cap.
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, PREFILL_MAX[field]);
  if (field === "link" && value && !/^https?:\/\/\S+$/i.test(value)) return "";
  return value;
}

/** Campaign-attribution params we carry through shared links untouched. */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
] as const;

/**
 * Attribution params on the current URL, so a link copied from a campaign
 * visit keeps its UTM tags instead of silently dropping the attribution.
 */
export function trackingParamsFromSearch(search: string): [string, string][] {
  const params = new URLSearchParams(search);
  const out: [string, string][] = [];
  for (const key of TRACKING_PARAMS) {
    const value = params.get(key);
    if (value) out.push([key, value.slice(0, 200)]);
  }
  return out;
}

/**
 * The canonical order-form URL, optionally prefilling a package and the
 * artist's entered details so a shared link restores the form. Any UTM params
 * on the current address bar ride along unchanged.
 */
export function orderUrl(
  pkg?: OrderPackage | null,
  prefill?: OrderPrefill | null,
  pathname = "/",
): string {
  const params = new URLSearchParams();
  if (pkg) params.set("package", PACKAGE_SLUGS[pkg]);
  for (const field of ["artist", "email", "link"] as const) {
    const value = cleanValue(field, prefill?.[field]);
    if (value) params.set(PREFILL_PARAMS[field], value);
  }
  if (typeof window !== "undefined") {
    for (const [key, value] of trackingParamsFromSearch(window.location.search)) {
      params.set(key, value);
    }
  }
  const search = params.toString();
  return search ? `${pathname}?${search}#order` : `${pathname}#order`;
}


/** Reads `?package=<slug>`, accepting aliases and loose casing. */
export function packageFromSearch(search: string): OrderPackage | null {
  return resolvePackageSlug(new URLSearchParams(search).get("package"));
}

/**
 * Auto-corrects `?package=` in the address bar: recognized aliases/casing are
 * rewritten to the canonical slug, unrecognized values are dropped. The hash
 * (`#order`), every other query param, and the history entry are untouched —
 * this only ever replaces the current entry.
 *
 * @returns the resolved package, or null when there was none (or it was invalid).
 */
export function sanitizeOrderPackageParam(): OrderPackage | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("package");
  if (raw === null) return null;

  const pkg = resolvePackageSlug(raw);
  const canonical = pkg ? PACKAGE_SLUGS[pkg] : null;
  if (canonical === raw) return pkg;

  if (canonical) url.searchParams.set("package", canonical);
  else url.searchParams.delete("package");

  const href = `${url.pathname}${url.search}${url.hash}`;
  const previous = readOrderHistoryState(window.history.state);
  const state = {
    ...(window.history.state ?? {}),
    order: { pkg, focusId: previous?.focusId ?? null },
  };
  window.history.replaceState(state, "", href);
  return pkg;
}


/** Reads the prefillable detail fields from a query string, sanitized. */
export function prefillFromSearch(search: string): Required<OrderPrefill> {
  const params = new URLSearchParams(search);
  return {
    artist: cleanValue("artist", params.get(PREFILL_PARAMS.artist)),
    email: cleanValue("email", params.get(PREFILL_PARAMS.email)),
    link: cleanValue("link", params.get(PREFILL_PARAMS.link)),
  };
}

/** History state we attach so back/forward can restore the form exactly. */
export type OrderHistoryState = {
  /** Package selected on that history entry. */
  pkg: OrderPackage | null;
  /** DOM id of the control that was focused when the entry was created. */
  focusId: string | null;
};

/** Reads our order state off a history entry, if present. */
export function readOrderHistoryState(state: unknown): OrderHistoryState | null {
  const order = (state as { order?: unknown } | null)?.order as
    | Partial<OrderHistoryState>
    | undefined;
  if (!order) return null;
  const pkg =
    typeof order.pkg === "string" && (ORDER_PACKAGES as readonly string[]).includes(order.pkg)
      ? (order.pkg as OrderPackage)
      : null;
  return { pkg, focusId: typeof order.focusId === "string" ? order.focusId : null };
}

function buildOrderHref(pkg: OrderPackage, prefill?: OrderPrefill | null) {
  const url = new URL(window.location.href);
  url.searchParams.set("package", PACKAGE_SLUGS[pkg]);
  for (const field of ["artist", "email", "link"] as const) {
    const value = cleanValue(field, prefill?.[field]);
    if (value) url.searchParams.set(PREFILL_PARAMS[field], value);
    else url.searchParams.delete(PREFILL_PARAMS[field]);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Keeps the address bar in sync with the selected package (and any entered
 * details) without adding a history entry or touching the current hash.
 * Existing order history state (package + focus) is preserved.
 */
export function syncOrderUrl(pkg: OrderPackage, prefill?: OrderPrefill | null, focusId?: string) {
  if (typeof window === "undefined") return;
  const previous = readOrderHistoryState(window.history.state);
  const state = { ...(window.history.state ?? {}), order: { pkg, focusId: focusId ?? previous?.focusId ?? null } };
  window.history.replaceState(state, "", buildOrderHref(pkg, prefill));
}

/**
 * Adds a history entry for a tier change, remembering both the package and the
 * control that was focused, so Back/Forward restores the exact form state.
 */
export function pushOrderUrl(pkg: OrderPackage, prefill?: OrderPrefill | null, focusId?: string) {
  if (typeof window === "undefined") return;
  const state = { ...(window.history.state ?? {}), order: { pkg, focusId: focusId ?? null } };
  window.history.pushState(state, "", buildOrderHref(pkg, prefill));
}

/** Back-compat: sync only the package selection. */
export function syncPackageInUrl(pkg: OrderPackage) {
  syncOrderUrl(pkg);
}


/* ------------------------------------------------------------------ *
 * Local persistence — survives a reload on the same device.
 * ------------------------------------------------------------------ */

const STORAGE_KEY = "hybrid.order.prefill.v1";

export function saveOrderPrefill(pkg: OrderPackage, prefill: OrderPrefill) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        pkg,
        artist: cleanValue("artist", prefill.artist),
        email: cleanValue("email", prefill.email),
        link: cleanValue("link", prefill.link),
      }),
    );
  } catch {
    /* storage unavailable (private mode, quota) — prefill is best-effort */
  }
}

export function loadOrderPrefill(): (Required<OrderPrefill> & { pkg: OrderPackage | null }) | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pkgValue = typeof parsed.pkg === "string" ? parsed.pkg : "";
    return {
      pkg: (ORDER_PACKAGES as readonly string[]).includes(pkgValue)
        ? (pkgValue as OrderPackage)
        : null,
      artist: cleanValue("artist", typeof parsed.artist === "string" ? parsed.artist : ""),
      email: cleanValue("email", typeof parsed.email === "string" ? parsed.email : ""),
      link: cleanValue("link", typeof parsed.link === "string" ? parsed.link : ""),
    };
  } catch {
    return null;
  }
}

export function clearOrderPrefill() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

