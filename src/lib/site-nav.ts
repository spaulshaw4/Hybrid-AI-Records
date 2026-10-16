export const MERCH_URL = "https://hybrid-ai-records-llc.printful.me";

/** Same array as `PORTAL_MENU`. Do not declare a second destination list. */
export { PORTAL_MENU as SITE_NAV } from "@/lib/portal-tabs";

export function shouldShowSiteNav(pathname: string) {
  if (pathname.startsWith("/admin")) return false;
  if (pathname.startsWith("/auth")) return false;
  if (pathname.includes("oauth")) return false;
  if (pathname.startsWith("/dev")) return false;
  return true;
}
