import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RouteErrorFallback } from "./components/RouteErrorFallback";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      // Generation jobs outlive a dropped socket. A retry starts another render.
      mutations: { retry: false },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // Any route without its own boundary still gets the branded fallback
    // instead of a blank screen or a raw error dump.
    defaultErrorComponent: RouteErrorFallback,
  });

  return router;
};
