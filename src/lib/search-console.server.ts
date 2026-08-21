/**
 * Server-only Google Search Console gateway helpers.
 *
 * All calls go through the Lovable connector gateway so the connected Google
 * account's OAuth token is refreshed for us. Never call Google directly.
 */

const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_search_console";

export type SiteEntry = { siteUrl: string; permissionLevel?: string };

function gatewayHeaders() {
  const lovableApiKey = process.env["LOVABLE_API_KEY"];
  const connectionApiKey = process.env["GOOGLE_SEARCH_CONSOLE_API_KEY"];
  if (!lovableApiKey || !connectionApiKey) {
    throw new Error(
      "Search Console is not connected for this project yet. Link the Google Search Console connector, then reload.",
    );
  }
  return {
    Authorization: `Bearer ${lovableApiKey}`,
    "X-Connection-Api-Key": connectionApiKey,
  } satisfies Record<string, string>;
}

async function gatewayRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(45_000),
    headers: { ...gatewayHeaders(), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(`Search Console gateway failed [${response.status}]: ${body}`);
    if (response.status === 403) {
      throw new Error(
        "The connected Google account can't access this Search Console property.",
      );
    }
    throw new Error(`Search Console request failed [${response.status}]: ${body}`);
  }
  return response;
}

async function gatewayFetch(path: string, init?: RequestInit) {
  const response = await gatewayRequest(path, init);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}


/** True when the verified property covers the target URL. */
export function coversTarget(siteUrl: string, target: URL) {
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).toLowerCase();
    const host = target.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  try {
    return target.href.startsWith(new URL(siteUrl).href);
  } catch {
    return false;
  }
}

export type SiteResolution =
  | { status: "selected"; siteUrl: string }
  | { status: "selection_required"; candidates: string[] };

/** Lists verified properties and matches them against the target site. */
export async function resolveSiteUrl(
  targetUrl: string,
  selectedSiteUrl?: string,
): Promise<SiteResolution> {
  const json = (await gatewayFetch("/webmasters/v3/sites")) as { siteEntry?: SiteEntry[] };
  const target = new URL(targetUrl);
  const matches = (json.siteEntry ?? []).filter(
    (entry) =>
      entry.permissionLevel !== "siteUnverifiedUser" && coversTarget(entry.siteUrl, target),
  );

  if (selectedSiteUrl) {
    const selected = matches.find((entry) => entry.siteUrl === selectedSiteUrl);
    if (!selected) {
      throw new Error("That Search Console property is not verified for this site.");
    }
    return { status: "selected", siteUrl: selected.siteUrl };
  }
  if (matches.length === 0) {
    throw new Error("No verified Search Console property covers hybrid-ai-records.com.");
  }
  if (matches.length === 1) return { status: "selected", siteUrl: matches[0]!.siteUrl };
  return { status: "selection_required", candidates: matches.map((entry) => entry.siteUrl) };
}

export type AnalyticsRow = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };

export async function searchAnalytics(
  siteUrl: string,
  body: Record<string, unknown>,
): Promise<AnalyticsRow[]> {
  const json = (await gatewayFetch(
    `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )) as { rows?: AnalyticsRow[] };
  return json.rows ?? [];
}

export type SitemapStatus = {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  warnings: number;
  errors: number;
  submitted: number;
  indexed: number;
};

export async function listSitemaps(siteUrl: string): Promise<SitemapStatus[]> {
  const json = (await gatewayFetch(
    `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
  )) as {
    sitemap?: Array<{
      path: string;
      lastSubmitted?: string;
      lastDownloaded?: string;
      isPending?: boolean;
      warnings?: string | number;
      errors?: string | number;
      contents?: Array<{ submitted?: string | number; indexed?: string | number }>;
    }>;
  };
  return (json.sitemap ?? []).map((entry) => {
    const contents = entry.contents ?? [];
    const sum = (key: "submitted" | "indexed") =>
      contents.reduce((total, item) => total + Number(item[key] ?? 0), 0);
    return {
      path: entry.path,
      lastSubmitted: entry.lastSubmitted ?? null,
      lastDownloaded: entry.lastDownloaded ?? null,
      isPending: Boolean(entry.isPending),
      warnings: Number(entry.warnings ?? 0),
      errors: Number(entry.errors ?? 0),
      submitted: sum("submitted"),
      indexed: sum("indexed"),
    };
  });
}

export type UrlIndexState = {
  coverageState: string | null;
  verdict: string | null;
  lastCrawlTime: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
};

export async function inspectUrl(siteUrl: string, inspectionUrl: string): Promise<UrlIndexState> {
  const json = (await gatewayFetch("/v1/urlInspection/index:inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl, siteUrl }),
  })) as {
    inspectionResult?: {
      indexStatusResult?: Record<string, string>;
    };
  };
  const result = json.inspectionResult?.indexStatusResult ?? {};
  return {
    coverageState: result["coverageState"] ?? null,
    verdict: result["verdict"] ?? null,
    lastCrawlTime: result["lastCrawlTime"] ?? null,
    robotsTxtState: result["robotsTxtState"] ?? null,
    indexingState: result["indexingState"] ?? null,
    googleCanonical: result["googleCanonical"] ?? null,
    userCanonical: result["userCanonical"] ?? null,
  };
}

/** Normalises one raw Search Console sitemap entry into `SitemapStatus`. */
function toSitemapStatus(entry: {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  warnings?: string | number;
  errors?: string | number;
  contents?: Array<{ submitted?: string | number; indexed?: string | number }>;
}): SitemapStatus {
  const contents = entry.contents ?? [];
  const sum = (key: "submitted" | "indexed") =>
    contents.reduce((total, item) => total + Number(item[key] ?? 0), 0);
  return {
    path: entry.path,
    lastSubmitted: entry.lastSubmitted ?? null,
    lastDownloaded: entry.lastDownloaded ?? null,
    isPending: Boolean(entry.isPending),
    warnings: Number(entry.warnings ?? 0),
    errors: Number(entry.errors ?? 0),
    submitted: sum("submitted"),
    indexed: sum("indexed"),
  };
}

/** Submits (or re-submits) a sitemap URL to Search Console. Returns nothing on success. */
export async function submitSitemap(siteUrl: string, sitemapUrl: string): Promise<void> {
  await gatewayRequest(
    `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
    { method: "PUT" },
  );
}

/**
 * Reads the processing status Google reports for one sitemap.
 * Returns null when Google hasn't registered it yet (404 right after a submit).
 */
export async function getSitemapStatus(
  siteUrl: string,
  sitemapUrl: string,
): Promise<SitemapStatus | null> {
  try {
    const json = (await gatewayFetch(
      `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
    )) as Parameters<typeof toSitemapStatus>[0] & { path?: string };
    if (!json?.path) return null;
    return toSitemapStatus(json as Parameters<typeof toSitemapStatus>[0]);
  } catch (error) {
    if (error instanceof Error && /\[404\]/.test(error.message)) return null;
    throw error;
  }
}
