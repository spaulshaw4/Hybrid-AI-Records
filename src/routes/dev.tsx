import { createFileRoute, Outlet } from "@tanstack/react-router";

import { devOnlyBeforeLoad } from "@/lib/dev-route-guard";

/**
 * Layout gate for every internal /dev/* harness page.
 *
 * Runs before any child route (translations, background-report, sync-badge,
 * sync-badge-lab, sync-history) so a production visitor gets a plain 404
 * instead of internal tooling. Children keep their own guard as defence in
 * depth.
 */
export const Route = createFileRoute("/dev")({
  beforeLoad: devOnlyBeforeLoad,
  component: () => <Outlet />,
});
