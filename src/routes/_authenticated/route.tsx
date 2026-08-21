import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

export const Route = createFileRoute("/_authenticated")({
  errorComponent: RouteErrorFallback,
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      // Remember where they were headed so sign-in can send them back.
      const next = `${location.pathname}${location.searchStr ?? ""}${location.hash ? `#${location.hash}` : ""}`;
      throw redirect({ to: "/auth", search: next && next !== "/" ? { next } : {} });
    }
    return { user: data.user };
  },
  component: () => <Outlet />,
});
