import type { ComponentType } from "react";
import { CreditCard, Disc, Film, Radio, Sparkles } from "lucide-react";

import { resolvePortalTab } from "@/lib/portal-tabs";

export const MERCH_URL = "https://hybrid-ai-records-llc.printful.me";

export interface NavEntry {
  label: string;
  href: string;
  tab: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Canonical portal destinations. `resolvePortalTab` aliases `catalog` to
 * catalog_merch and `video` to distribution. Do not declare a second list.
 */
export const SITE_NAV: NavEntry[] = [
  { label: "Create Your Track", href: "/portal?tab=create", tab: "create", icon: Sparkles },
  { label: "Catalog & Merch", href: "/portal?tab=catalog", tab: "catalog", icon: Disc },
  { label: "Plans & Tokens", href: "/portal?tab=plans", tab: "plans", icon: CreditCard },
  { label: "Hybrid AI Radio", href: "/portal?tab=radio", tab: "radio", icon: Radio },
  { label: "Distribution & Video Packages", href: "/portal?tab=distribution", tab: "distribution", icon: Film },
];

/** Active when the resolved portal tab matches this entry, including aliases. */
export function isSiteNavEntryActive(entry: NavEntry, rawTab: unknown, onPortal: boolean) {
  if (!onPortal) return false;
  return resolvePortalTab(entry.tab) === resolvePortalTab(rawTab);
}

export function shouldShowSiteNav(pathname: string) {
  if (pathname.startsWith("/admin")) return false;
  if (pathname.startsWith("/auth")) return false;
  if (pathname.includes("oauth")) return false;
  if (pathname.startsWith("/dev")) return false;
  return true;
}
