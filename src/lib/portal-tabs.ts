export type PortalTab = "create" | "catalog" | "merch" | "radio" | "distribution";

const PORTAL_TAB_IDS = {
  "make-track": "create",
  catalog: "catalog",
  merch: "merch",
  radio: "radio",
  packages: "distribution",
} as const;

export type PortalNavId = keyof typeof PORTAL_TAB_IDS;

export function portalTabForNavId(id: PortalNavId): PortalTab {
  return PORTAL_TAB_IDS[id];
}

/** `?tab=video` stays on Distribution & Video Packages. Missing tab is Create. */
export function resolvePortalTab(tab: unknown): PortalTab {
  if (tab === "video" || tab === "distribution") return "distribution";
  if (tab === "create" || tab === "catalog" || tab === "merch" || tab === "radio") return tab;
  return "create";
}
