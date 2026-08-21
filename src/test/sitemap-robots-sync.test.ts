/**
 * Automated sync check between the declared routes, sitemap.xml and robots.txt.
 *
 * Rules enforced:
 *  1. Every public (indexable) route file has a <loc> in sitemap.xml.
 *  2. Every noindex route is absent from sitemap.xml.
 *  3. Every noindex route is covered by a Disallow rule in robots.txt.
 *  4. robots.txt points at the sitemap on the same origin the sitemap emits.
 *  5. sitemap.xml contains no duplicates and only absolute BASE_URL locs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVICES } from "@/lib/services";
import { Route as SitemapRoute } from "@/routes/sitemap[.]xml";

const ROOT = process.cwd();
const ROUTES_DIR = join(ROOT, "src/routes");

/** Files/dirs that are not user-facing HTML pages. */
const NON_PAGE = [
  /^__root\.tsx$/,
  /^README\.md$/,
  /^sitemap\[\.\]xml\.ts$/,
  /^mcp\.ts$/,
  /^api[/\\]/,
  /^\[\.mcp\][/\\]/,
  /^\[\.well-known\][/\\]/,
  /\.test\.tsx?$/,
  /(^|[/\\])route\.tsx$/,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Turns a route filename into its URL path(s). Dynamic segments expand. */
function routePaths(rel: string): string[] {
  const base = rel.replace(/\.tsx?$/, "").replace(/\\/g, "/");
  const segments = base
    .split("/")
    .flatMap((part) => part.split("."))
    .filter((s) => s.length > 0 && s !== "index" && !s.startsWith("_"));

  if (segments.some((s) => s.startsWith("["))) return [];

  const build = (acc: string[], rest: string[]): string[] => {
    if (rest.length === 0) return [`/${acc.join("/")}`.replace(/\/+$/, "") || "/"];
    const [head, ...tail] = rest;
    if (head === "$package") return SERVICES.flatMap((s) => build([...acc, s.slug], tail));
    if (head.startsWith("$")) return [];
    return build([...acc, head], tail);
  };

  return build([], segments);
}

type PageRoute = { file: string; paths: string[]; noindex: boolean };

function collectRoutes(): PageRoute[] {
  return walk(ROUTES_DIR)
    .map((full) => relative(ROUTES_DIR, full).replace(/\\/g, "/"))
    .filter((rel) => !NON_PAGE.some((re) => re.test(rel)))
    .filter((rel) => /\.tsx?$/.test(rel))
    .map((rel) => {
      const source = readFileSync(join(ROUTES_DIR, rel), "utf8");
      const paths = routePaths(rel);
      const noindex =
        /noindex:\s*true/.test(source) ||
        rel.startsWith("_authenticated/") ||
        rel.startsWith("dev.");
      return { file: rel, paths, noindex };
    })
    .filter((r) => r.paths.length > 0);
}

async function sitemapLocs() {
  const handlers = SitemapRoute.options.server!.handlers as unknown as {
    GET: () => Promise<Response>;
  };
  const xml = await (await handlers.GET()).text();

  return {
    xml,
    locs: [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
  };
}

const BASE_URL = "https://hybrid-ai-records.com";
const robots = readFileSync(join(ROOT, "public/robots.txt"), "utf8");
const disallows = robots
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^Disallow:/i.test(l))
  .map((l) => l.replace(/^Disallow:\s*/i, ""))
  .filter(Boolean);

const isDisallowed = (path: string) => disallows.some((d) => path === d || path.startsWith(d));

describe("sitemap.xml / robots.txt stay in sync with declared routes", () => {
  it("lists every public route in the sitemap", async () => {
    const { locs } = await sitemapLocs();
    const paths = new Set(locs.map((l) => l.replace(BASE_URL, "") || "/"));
    const missing = collectRoutes()
      .filter((r) => !r.noindex)
      .flatMap((r) => r.paths)
      .filter((p) => !paths.has(p));
    expect(missing, `public routes missing from sitemap.xml: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps noindex routes out of the sitemap", async () => {
    const { locs } = await sitemapLocs();
    const paths = new Set(locs.map((l) => l.replace(BASE_URL, "") || "/"));
    const leaked = collectRoutes()
      .filter((r) => r.noindex)
      .flatMap((r) => r.paths)
      .filter((p) => paths.has(p));
    expect(leaked, `noindex routes present in sitemap.xml: ${leaked.join(", ")}`).toEqual([]);
  });

  it("disallows every noindex route in robots.txt", () => {
    const uncovered = collectRoutes()
      .filter((r) => r.noindex)
      .flatMap((r) => r.paths)
      .filter((p) => !isDisallowed(p));
    expect(uncovered, `noindex routes not disallowed in robots.txt: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("never disallows a route that is in the sitemap", async () => {
    const { locs } = await sitemapLocs();
    const blocked = locs.map((l) => l.replace(BASE_URL, "") || "/").filter(isDisallowed);
    expect(blocked, `sitemap URLs blocked by robots.txt: ${blocked.join(", ")}`).toEqual([]);
  });

  it("emits unique, absolute sitemap URLs on the canonical origin", async () => {
    const { locs, xml } = await sitemapLocs();
    expect(locs.length).toBeGreaterThan(0);
    expect(new Set(locs).size).toBe(locs.length);
    expect(locs.every((l) => l.startsWith(`${BASE_URL}/`) || l === BASE_URL)).toBe(true);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("advertises the sitemap from robots.txt on the same origin", () => {
    expect(robots).toMatch(/^User-agent:\s*\*/m);
    expect(robots).toContain(`Sitemap: ${BASE_URL}/sitemap.xml`);
  });
});
