import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { WORDMARK_PRELOAD_LINK } from "@/components/Wordmark";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { LivingBackground } from "@/components/LivingBackground";
import { RouteTransition } from "@/components/RouteTransition";
import { BackgroundDebug } from "@/components/BackgroundDebug";
import { SiteChrome } from "@/components/SiteNav";
import { CatalogAudioHost } from "@/components/CatalogAudioHost";

import { PageTranslator, languageInfo, useLanguageState } from "@/lib/i18n";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { SessionExpiredBanner } from "@/components/SessionExpiredBanner";
import { supabase } from "@/integrations/supabase/client";
import { ensureUserProfile, takeOAuthNext } from "@/lib/ensure-user-profile";
import { installStaticChargeMonitor } from "@/lib/static-charge";

import { useRouteRetry } from "@/lib/use-route-retry";
import { installOverlayCompositingGuard } from "@/lib/overlay-compositing";

import { subscribeRouteSnapshots } from "@/lib/route-snapshot";

import { DirectionProvider } from "@radix-ui/react-direction";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { installClientErrorReporting } from "@/lib/client-error-report";
import { addBreadcrumb } from "@/lib/client-breadcrumbs";
import { armWhiteScreenWatch, installWhiteScreenWatch } from "@/lib/white-screen-watch";
import { initSafeMode, subscribeSafeMode } from "@/lib/webkit-safe-mode";
import { installPerfWatch } from "@/lib/perf-watch";
import { useErrorRouteContext } from "@/lib/error-context";
import { ErrorReference } from "@/components/ErrorReference";

import { getSurchargeSettings } from "@/lib/pricing-settings.functions";
import { getFxRates } from "@/lib/fx-rates.functions";
import { applySurchargeBps } from "@/lib/pricing";
import { applyFxRates } from "@/lib/fx";



function NotFoundComponent() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background/40 px-4 backdrop-blur-sm">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The signal cut out. This page doesn't exist.
        </p>
        <div className="mt-6">
          <Link to="/" className="btn-primary">Back to base</Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const context = useErrorRouteContext(error);
  const { retry, isRetrying, attempts, cached } = useRouteRetry(context.routeId, reset);

  useEffect(() => {
    reportLovableError(error, {
      boundary: "tanstack_root_error_component",
      reference: context.reference,
      routeId: context.routeId,
      stage: context.stage,
      params: context.params.join(" · "),
      search: context.search.join(" · "),
    });
  }, [error, context]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background/40 px-4 backdrop-blur-sm">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Something broke in the mix
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Try again, or head back to the front page.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Section <span className="font-mono">{context.routeId}</span> · failed while{" "}
          {context.stage === "loader" ? "loading data" : "rendering"}
        </p>
        {(context.params.length > 0 || context.search.length > 0) && (
          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
            {[...context.params, ...context.search].join(" · ")}
          </p>
        )}
        <ErrorReference
          context={context}
          message={error instanceof Error ? error.message : undefined}
          className="mt-4"
        />

        {cached && (
          <div className="mt-4 rounded-lg border border-border/50 bg-background/50 p-3 text-left">
            <p className="text-xs font-medium text-foreground">
              Showing the last version we loaded ·{" "}
              <span className="font-normal text-muted-foreground">
                {new Date(cached.capturedAt).toLocaleTimeString()}
              </span>
            </p>
            <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
              {cached.fields.map((field) => (
                <div key={field.label} className="flex gap-2">
                  <dt className="min-w-24 text-foreground/80">{field.label}</dt>
                  <dd className="font-mono break-all">{field.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => void retry()}
            disabled={isRetrying}
            className="btn-primary disabled:opacity-60"
          >
            {isRetrying ? "Retrying…" : attempts >= 1 ? "Try again anyway" : "Try again"}
          </button>

          <a href="/" className="btn-ghost">Go home</a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { title: "Hybrid AI Records — Raw Words. Real Music. Global Impact." },
      { name: "description", content: "Independent, veteran-owned record label. Fixed-cost, release-ready tracks. You write it, you own it — 100% royalties, 100% masters, forever." },
      { name: "author", content: "Hybrid AI Records LLC" },
      // iOS ignores the web manifest for home-screen behaviour; these legacy
      // Apple tags are what make the saved icon launch full-screen (no Safari
      // chrome) with the dark status bar instead of opening as a bookmark.
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Hybrid AI" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "theme-color", content: "#F8FAFC" },
      { name: "color-scheme", content: "light" },
      { name: "google-site-verification", content: "m1otQjaUXvcwPvs8obRO5pWpribQVgsa4K29fkfE87o" },
      { property: "og:site_name", content: "Hybrid AI Records" },
      { property: "og:locale", content: "en_US" },
      { property: "og:title", content: "Hybrid AI Records — Raw Words. Real Music. Global Impact." },
      { property: "og:description", content: "Fixed-cost, release-ready tracks for the artists the industry forgot to pay. 100% ownership. Global digital rollout." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Hybrid AI Records — Raw Words. Real Music. Global Impact." },
      { name: "twitter:description", content: "Fixed-cost, release-ready tracks for the artists the industry forgot to pay. 100% ownership. Global digital rollout." },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Header lockup: preloaded so the sticky header paints its mark with the
      // first frame instead of flashing an empty box and reflowing.
      WORDMARK_PRELOAD_LINK,
      // Address-bar / tab / history icon. The .ico is listed first and also
      // served at the default /favicon.ico path, because that is the file
      // browsers cache for omnibox suggestions — without it they can keep
      // showing a stale icon inherited from an older page at this address.
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", href: "/icons/icon-32.png", type: "image/png", sizes: "32x32" },
      { rel: "icon", href: "/icons/icon-48.png", type: "image/png", sizes: "48x48" },
      { rel: "icon", href: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
      { rel: "shortcut icon", href: "/favicon.ico" },

      // Full-bleed dark icon: iOS crops to its own rounded square, so any
      // padding here would show as a border around the crest.
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png", sizes: "180x180" },
      { rel: "manifest", href: "/manifest.webmanifest" },

      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
    ],
  }),
  // Pulls the admin-configured processing surcharge and the daily exchange
  // rates so SSR and the browser quote the same live prices. Never blocks the
  // app if either read fails.
  loader: async () => {
    const [surcharge, fx] = await Promise.all([
      getSurchargeSettings().catch(() => null),
      getFxRates().catch(() => null),
    ]);
    // Applied here (before any component renders) so prices never flash the
    // default rate, and so the store never notifies subscribers mid-render.
    if (surcharge?.rates) applySurchargeBps(surcharge.rates);
    if (fx) applyFxRates(fx);
    return { surcharge, fx };
  },


  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="app-bg" data-site-nav="on">
      <head>
        <HeadContent />
        {/* Drop stale SW/cache so redeploys (e.g. payment banner) aren't stuck. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(registrations) {
      for (let registration of registrations) {
        registration.unregister();
      }
    });
  }
  if ('caches' in window) {
    caches.keys().then(function(names) {
      for (let name of names) caches.delete(name);
    });
  }
`,
          }}
        />
        {/* Silver mesh until the living background paints. Avoid !important
            so the repeating wallpaper can still cover html/body. */}
        <style>{`html,body{margin:0;padding:0;background-color:#121316;background-image:radial-gradient(circle at 18% 22%,rgba(220,38,38,.5),transparent 58%),radial-gradient(circle at 82% 78%,rgba(29,78,216,.5),transparent 58%),radial-gradient(circle at 50% 46%,rgba(248,250,252,.2),transparent 52%),linear-gradient(#121316,#121316);background-repeat:no-repeat;background-size:cover;background-attachment:scroll;}`}</style>
      </head>
      <body className="min-h-screen bg-[#121316]">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const { language } = useLanguageState();
  const dir = languageInfo(language).rtl ? "rtl" : "ltr";
  const router = useRouter();

  useEffect(() => {
    const stopChargeMonitor = installStaticChargeMonitor();

    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        void ensureUserProfile(session.user).then(() => {
          const next = takeOAuthNext();
          if (next && next !== window.location.pathname) {
            window.location.assign(next);
          }
        });
      }
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      void router.invalidate();
      if (event === "SIGNED_OUT") {
        queryClient.clear();
      } else {
        void queryClient.invalidateQueries();
      }
    });
    return () => {
      stopChargeMonitor();
      subscription.subscription.unsubscribe();
    };
  }, [queryClient, router]);

  useEffect(() => {
    void import("../lib/register-sw").then((m) => m.registerOfflineShell());
  }, []);

  // Keeps a small last-known-good snapshot of each route's loader data so the
  // error boundary can fall back to it when a retry fails again.
  // WebKit Safe Mode: restores the persisted decision (and re-applies the
  // html flag) before anything decorative renders, then announces it once if
  // the detector engages it mid-session.
  useEffect(() => {
    const initial = initSafeMode();
    let announced = initial.active;
    return subscribeSafeMode((state) => {
      if (state.active && !announced) {
        announced = true;
        toast.message("Safe Mode on", {
          description:
            "This device hit repeated display glitches, so animations and glass effects are off. Turn them back on in Diagnostics.",
          duration: 8000,
          action: { label: "Diagnostics", onClick: () => router.navigate({ to: "/diagnostics" }) },
        });
      }
      if (!state.active) announced = false;
    });
  }, [router]);

  useEffect(() => {
    installClientErrorReporting();
    // iOS crash/white-screen instrumentation: lifecycle + viewport breadcrumbs
    // plus a blank-render watchdog, so a silent Safari failure still reports.
    installWhiteScreenWatch();
  }, []);

  // Runtime performance watch: long tasks, dropped frames and memory pressure,
  // recorded on the same timeline as crashes so mobile Safari jank is visible.
  useEffect(() => installPerfWatch(), []);

  // Records every navigation as a breadcrumb and re-arms the blank-screen
  // check, which is what catches a route that renders nothing on mobile.
  useEffect(
    () =>
      router.subscribe("onResolved", ({ toLocation }) => {
        addBreadcrumb("navigation", toLocation.pathname);
        armWhiteScreenWatch(`navigate:${toLocation.pathname}`);
      }),
    [router],
  );

  useEffect(() => subscribeRouteSnapshots(router), [router]);

  // iOS Safari: park the animated background layers while a style menu, sheet
  // or modal is open so WebKit's compositor never drops the tree to black.
  useEffect(() => installOverlayCompositingGuard(), []);




  return (
    <QueryClientProvider client={queryClient}>
      {/* Radix portals (dialogs, dropdowns, selects) read direction from here. */}
      <DirectionProvider dir={dir}>
        <PageTranslator />
        <LivingBackground />
        <SessionExpiredBanner />
        <AppErrorBoundary>
          <SiteChrome>
            <RouteTransition>
              <Outlet />
            </RouteTransition>
          </SiteChrome>
        </AppErrorBoundary>
        <BackgroundDebug />

        {/* Top-center so confirmations stay visible above open dialogs
            (settings, divisions) instead of hiding behind bottom-corner UI. */}
        <Toaster position="top-center" richColors closeButton expand duration={3500} />
        <CatalogAudioHost />
      </DirectionProvider>

    </QueryClientProvider>
  );
}
