export const MERCH_URL = "https://hybrid-ai-recordsl-llc.printful.me/";

export type SiteNavItem = {
  id: "make-track" | "catalog" | "merch" | "radio" | "packages";
  label: string;
  short: string;
  icon: "audio" | "catalog" | "merch" | "radio" | "packages";
} & (
  | { to: "/engine"; hash?: undefined; href?: undefined; search?: undefined }
  | { to: "/artists"; hash?: undefined; href?: undefined; search?: undefined }
  | { to: "/"; hash: "radio"; href?: undefined; search?: undefined }
  | { to: "/portal"; search: { view: "services" }; hash?: undefined; href?: undefined }
  | { href: string; to?: undefined; hash?: undefined; search?: undefined }
);

export const SITE_NAV: SiteNavItem[] = [
  { id: "make-track", label: "Make Your Track", short: "Create", icon: "audio", to: "/engine" },
  { id: "catalog", label: "Catalog & Tracks", short: "Catalog", icon: "catalog", to: "/artists" },
  { id: "merch", label: "Merch", short: "Merch", icon: "merch", href: MERCH_URL },
  { id: "radio", label: "Hybrid AI Radio", short: "Radio", icon: "radio", to: "/", hash: "radio" },
  {
    id: "packages",
    label: "Distribution & Video Packages",
    short: "Packages",
    icon: "packages",
    to: "/portal",
    search: { view: "services" },
  },
];

export function shouldShowSiteNav(pathname: string) {
  if (pathname.startsWith("/admin")) return false;
  if (pathname.startsWith("/auth")) return false;
  if (pathname.includes("oauth")) return false;
  if (pathname.startsWith("/dev")) return false;
  return true;
}

export function isSiteNavActive(
  item: SiteNavItem,
  pathname: string,
  search: Record<string, unknown>,
  hash: string,
) {
  if (item.id === "make-track") {
    return pathname === "/engine" || pathname === "/studio" || pathname === "/cinematic-studio";
  }
  if (item.id === "catalog") return pathname === "/artists";
  if (item.id === "radio") {
    return pathname === "/" && hash.replace(/^#/, "") === "radio";
  }
  if (item.id === "packages") {
    return pathname === "/portal" && search.view === "services";
  }
  return false;
}
