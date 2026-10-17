export type PortalTab = "create" | "catalog_merch" | "plans" | "radio" | "distribution";

/**
 * `?tab=video` opens Distribution. `?tab=catalog` and `?tab=merch` open Catalog & Merch.
 * Anything else unknown, including a missing tab, opens Create.
 * The destination list itself is `SITE_NAV` in src/lib/site-nav.ts.
 */
export function resolvePortalTab(tab: unknown): PortalTab {
  if (tab === "video" || tab === "distribution") return "distribution";
  if (tab === "catalog" || tab === "merch" || tab === "catalog_merch") return "catalog_merch";
  if (tab === "plans" || tab === "create" || tab === "radio") return tab;
  return "create";
}
