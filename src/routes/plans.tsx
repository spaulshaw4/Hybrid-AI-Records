import { createFileRoute, redirect } from "@tanstack/react-router";

/** Short public href for the plans surface. The portal tab is the real page. */
export const Route = createFileRoute("/plans")({
  beforeLoad: () => {
    throw redirect({
      to: "/portal",
      search: { tab: "plans" },
    });
  },
});
