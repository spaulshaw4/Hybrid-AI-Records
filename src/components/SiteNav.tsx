import { useEffect, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  AudioLines,
  Clapperboard,
  Library,
  Mic2,
  ShoppingBag,
} from "lucide-react";

import { Wordmark, WORDMARK_LINK } from "@/components/Wordmark";
import { CurrencySwitcher } from "@/components/CurrencySwitcher";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { cn } from "@/lib/utils";
import {
  SITE_NAV,
  isSiteNavActive,
  shouldShowSiteNav,
  type SiteNavItem,
} from "@/lib/site-nav";

const ICONS = {
  audio: AudioLines,
  catalog: Library,
  merch: ShoppingBag,
  podcast: Mic2,
  packages: Clapperboard,
} as const;

function NavLink({
  item,
  compact,
  active,
}: {
  item: SiteNavItem;
  compact?: boolean;
  active: boolean;
}) {
  const isCreate = item.id === "make-track";
  const Icon = ICONS[item.icon];
  const className = isCreate
    ? cn(
        "flex items-center rounded-lg bg-gradient-to-r from-red-600/20 to-transparent border-l-4 border-red-500 text-white outline-none transition-all hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-red-500",
        compact
          ? "mx-0.5 min-h-11 flex-1 flex-col justify-center gap-0.5 border-l-0 border-t-4 px-1 py-1.5"
          : "min-h-11 gap-3 px-4 py-3",
        active && "bg-white/10",
      )
    : cn(
        "flex items-center rounded-lg bg-zinc-900 border border-zinc-700 shadow-md outline-none transition-all hover:border-blue-500 hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-blue-400",
        compact
          ? "mx-0.5 min-h-11 flex-1 flex-col justify-center gap-0.5 px-1 py-1.5"
          : "min-h-11 gap-3 px-3 py-2",
        active && "border-blue-400 bg-zinc-800",
      );
  const label = (
    <>
      {isCreate ? (
        <span className="text-base text-red-500" aria-hidden>
          ✦
        </span>
      ) : (
        <Icon
          className={cn(
            "rwb-nav-icon shrink-0",
            compact ? "size-4" : "size-[18px]",
          )}
          aria-hidden
        />
      )}
      <span
        className={cn(
          "uppercase",
          isCreate
            ? "font-black tracking-widest text-white"
            : "rwb-flame rwb-flame-deep font-mono font-bold",
          compact
            ? "max-w-full truncate text-center text-[9px] tracking-[0.08em]"
            : isCreate
              ? "min-w-0 text-start text-sm"
              : "min-w-0 text-start text-[11px] tracking-[0.16em]",
        )}
      >
        {compact ? item.short : isCreate ? "Create" : item.label}
      </span>
    </>
  );

  if (item.href) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noreferrer"
        className={className}
        aria-current={active ? "page" : undefined}
      >
        {label}
      </a>
    );
  }

  if (item.to === "/portal") {
    return (
      <Link
        to="/portal"
        search={item.search}
        className={className}
        aria-current={active ? "page" : undefined}
      >
        {label}
      </Link>
    );
  }

  if (item.to === "/artists") {
    return (
      <Link to="/artists" className={className} aria-current={active ? "page" : undefined}>
        {label}
      </Link>
    );
  }

  if (item.to === "/" && item.hash === "podcast") {
    return (
      <Link to="/" hash="podcast" className={className} aria-current={active ? "page" : undefined}>
        {label}
      </Link>
    );
  }

  return (
    <Link to="/engine" className={className} aria-current={active ? "page" : undefined}>
      {label}
    </Link>
  );
}

function useActiveNav() {
  const location = useRouterState({
    select: (state) => ({
      pathname: state.location.pathname,
      search: state.location.search as Record<string, unknown>,
      hash: state.location.hash,
    }),
  });
  return {
    ...location,
    visible: shouldShowSiteNav(location.pathname),
  };
}

function SiteSidebar() {
  const { pathname, search, hash } = useActiveNav();

  return (
    <aside
      data-site-nav="sidebar"
      className="site-sidebar studio-glass pointer-events-auto fixed inset-y-0 start-0 z-40 hidden w-[var(--site-sidebar-width)] flex-col border-e lg:flex"
      aria-label="Primary"
    >
      <div className="flex h-[var(--site-header-height)] items-center border-b border-border/80 px-4">
        <Link to="/" aria-label="Hybrid AI Records — home" className={WORDMARK_LINK}>
          <Wordmark size="sm" interactive />
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-2 p-3">
        {SITE_NAV.map((item) => (
          <NavLink
            key={item.id}
            item={item}
            active={isSiteNavActive(item, pathname, search, hash)}
          />
        ))}
      </nav>
    </aside>
  );
}

function SiteHeader() {
  return (
    <header
      data-site-nav="header"
      className="site-topbar pointer-events-auto fixed top-0 z-50 flex w-full items-center justify-between gap-2 border-b border-white/10 bg-black/60 px-4 py-3 backdrop-blur-lg"
    >
      <Link
        to="/"
        aria-label="Hybrid AI Records — home"
        className={`${WORDMARK_LINK} min-w-0 lg:hidden`}
      >
        <Wordmark size="sm" interactive />
      </Link>
      <div className="ms-auto flex shrink-0 items-center justify-end gap-2">
        <CurrencySwitcher variant="pill" />
        <LanguageSwitcher menuAlign="end" />
      </div>
    </header>
  );
}

function SiteDock() {
  const { pathname, search, hash } = useActiveNav();

  return (
    <nav
      data-site-nav="dock"
      aria-label="Primary"
      className="site-dock pointer-events-auto fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 rounded-full border border-white/10 bg-black/70 px-1 py-1 shadow-2xl backdrop-blur-lg lg:hidden"
    >
      <div className="flex items-stretch">
        {SITE_NAV.map((item) => (
          <NavLink
            key={item.id}
            item={item}
            compact
            active={isSiteNavActive(item, pathname, search, hash)}
          />
        ))}
      </div>
    </nav>
  );
}

export function SiteChrome({ children }: { children: ReactNode }) {
  const { visible } = useActiveNav();

  useEffect(() => {
    const html = document.documentElement;
    if (visible) html.setAttribute("data-site-nav", "on");
    else html.removeAttribute("data-site-nav");
    return () => html.removeAttribute("data-site-nav");
  }, [visible]);

  if (!visible) return <>{children}</>;

  return (
    <>
      <SiteSidebar />
      <SiteHeader />
      <div className="site-chrome-content min-h-screen bg-transparent">{children}</div>
      <SiteDock />
    </>
  );
}
