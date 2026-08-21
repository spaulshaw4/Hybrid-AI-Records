import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy path — the Hybrid AI Studio is now the Hybrid Engine 1.0. */
export const Route = createFileRoute("/studio")({
  beforeLoad: () => {
    throw redirect({ to: "/engine" });
  },
});
