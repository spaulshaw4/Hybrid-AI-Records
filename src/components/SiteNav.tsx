import { useEffect, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";

import { Footer } from "@/components/Footer";
import { HeaderTokenBalance } from "@/components/HeaderTokenBalance";
import { SettingsMenu } from "@/components/SettingsMenu";
import { Wordmark, WORDMARK_LINK } from "@/components/Wordmark";
import UserAuthButton from "@/components/studio/UserAuthButton";
import { cn } from "@/lib/utils";
import { isSiteNavEntryActive, shouldShowSiteNav, SITE_NAV } from "@/lib/site-nav";

export { SITE_NAV };

const NAV_FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500";

const NAV_ACTIVE =
  "rounded-full border border-red-500/40 bg-red-950/30 font-bold text-white shadow-[0_0_15px_rgba(239,68,68,0.35)] ring-1 ring-red-500/50";

const NAV_IDLE =
  "rounded-full border border-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100";

/**
 * Spendable tokens and the account menu.
 * Language, currency, and settings live in the account dropdown.
 * One horizontal row — never a stacked pill column.
 */
export function LocaleCluster({ className = "" }: { className?: string }) {
  return (
    <div
      className={cn("flex flex-row flex-nowrap items-center gap-3", className)}
      data-no-translate
    >
      <HeaderTokenBalance />
      <UserAuthButton />
    </div>
  );
}

function SiteNavEntries({ compact }: { compact?: boolean }) {
  const { pathname, search } = useActiveNav();
  const onPortal = pathname === "/portal";

  return SITE_NAV.map((item) => {
    const Icon = item.icon;
    const active = isSiteNavEntryActive(item, search.tab, onPortal);

    return (
      <Link
        key={item.href}
        to="/portal"
        search={{ tab: item.tab }}
        aria-current={active ? "page" : undefined}
        aria-label={item.label}
        activeOptions={{ exact: true }}
        className={cn(
          NAV_FOCUS,
          compact
            ? "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 py-1.5 text-center text-[10px] font-medium leading-none tracking-tight outline-none transition-colors"
            : "flex w-full items-center gap-3 rounded-full px-4 py-3 text-left text-xs tracking-wider transition-colors",
          active ? NAV_ACTIVE : NAV_IDLE,
        )}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            active && "text-red-400 drop-shadow-[0_0_6px_rgba(239,68,68,0.8)]",
          )}
          aria-hidden
        />
        <span className={cn("min-w-0 leading-snug", compact && "max-w-full truncate")}>{item.label}</span>
      </Link>
    );
  });
}

function useActiveNav() {
  const location = useRouterState({
    select: (state) => ({
      pathname: state.location.pathname,
      search: state.location.search as Record<string, unknown>,
    }),
  });
  return {
    ...location,
    visible: shouldShowSiteNav(location.pathname),
  };
}

function SiteSidebar() {
  return (
    <aside
      data-site-nav="sidebar"
      className="site-sidebar studio-glass pointer-events-auto fixed inset-y-0 start-0 z-40 hidden w-[var(--site-sidebar-width)] flex-col border-e lg:flex"
      aria-label="Primary"
    >
      <div className="flex h-[var(--site-header-height)] items-center border-0 border-transparent px-4">
        <Link to="/" aria-label="Hybrid AI Records — home" className={WORDMARK_LINK}>
          <Wordmark size="sm" interactive />
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-2 overflow-y-auto border-t-0 p-3" aria-label="Main Navigation">
        <SiteNavEntries />
      </nav>
    </aside>
  );
}

/** Fixed top bar: logo, live token pill, settings and account. */
function SiteHeader() {
  const { pathname } = useActiveNav();

  return (
    <header
      data-site-nav="header"
      className="site-topbar pointer-events-auto fixed top-0 z-50 flex h-14 items-center justify-between gap-2 border-b border-white/10 bg-black/80 px-3 backdrop-blur-md"
    >
      <div className={cn("flex min-w-0 shrink items-center gap-2", pathname === "/" && "lg:hidden")}>
        <Link
          to="/"
          aria-label="Hybrid AI Records — home"
          className={`${WORDMARK_LINK} shrink-0`}
        >
          <Wordmark size="sm" showText={false} interactive />
        </Link>
      </div>
      <div className="flex min-w-0 flex-1 justify-center px-1">
        <HeaderTokenBalance />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SettingsMenu variant="header" />
        <UserAuthButton />
      </div>
    </header>
  );
}

/**
 * Single bottom bar for every route. Same pill on the landing page, portal
 * radio/create tabs, and the rest of the site. Desktop keeps the sidebar.
 */
export function MobileNav() {
  return (
    <nav
      data-site-nav="dock"
      aria-label="Main Navigation"
      className="site-dock pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
    >
      <div className="pointer-events-auto flex w-full max-w-md items-stretch gap-0.5 rounded-full border border-white/10 bg-black/80 px-1.5 py-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.45)] backdrop-blur-md">
        <SiteNavEntries compact />
      </div>
    </nav>
  );
}

export function SiteChrome({ children }: { children: ReactNode }) {
  const { visible, pathname } = useActiveNav();

  useEffect(() => {
    const html = document.documentElement;
    if (visible) html.setAttribute("data-site-nav", "on");
    else html.removeAttribute("data-site-nav");
    return () => html.removeAttribute("data-site-nav");
  }, [visible]);

  // Homepage-only: hide chrome hairlines without changing glass borders on other routes.
  useEffect(() => {
    const html = document.documentElement;
    if (pathname === "/") html.setAttribute("data-page", "home");
    else html.removeAttribute("data-page");
    return () => html.removeAttribute("data-page");
  }, [pathname]);

  if (!visible) {
    return (
      <>
        {children}
        <Footer />
      </>
    );
  }

  return (
    <>
      <SiteSidebar />
      <SiteHeader />
      <div className="site-chrome-content flex min-h-screen min-w-0 w-full flex-col bg-transparent">
        <div className="min-w-0 w-full flex-1">{children}</div>
        <Footer />
      </div>
      <MobileNav />
    </>
  );
}
