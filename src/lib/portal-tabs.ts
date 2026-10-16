export type PortalTab = "create" | "catalog_merch" | "plans" | "radio" | "distribution";

export const PORTAL_MENU = [
  { id: "create", query: "create", label: "CREATE YOUR TRACK", short: "Create", icon: "sparkles" },
  { id: "catalog_merch", query: "catalog", label: "CATALOG & MERCH", short: "Catalog", icon: "disc" },
  { id: "plans", query: "plans", label: "PLANS & TOKENS", short: "Plans", icon: "card" },
  { id: "radio", query: "radio", label: "HYBRID AI RADIO", short: "Radio", icon: "radio" },
  { id: "distribution", query: "distribution", label: "DISTRIBUTION & VIDEO PACKAGES", short: "Distro", icon: "film" },
] as const;

export type PortalMenuIcon = (typeof PORTAL_MENU)[number]["icon"];

/**
 * `?tab=video` opens Distribution. `?tab=catalog` and `?tab=merch` open Catalog & Merch.
 * Anything else unknown, including a missing tab, opens Create.
 */
export function resolvePortalTab(tab: unknown): PortalTab {
  if (tab === "video" || tab === "distribution") return "distribution";
  if (tab === "catalog" || tab === "merch" || tab === "catalog_merch") return "catalog_merch";
  if (tab === "plans" || tab === "create" || tab === "radio") return tab;
  return "create";
}
