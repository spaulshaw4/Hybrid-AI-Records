import { useEffect, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  AudioLines,
  Clapperboard,
  Library,
  Radio,
  ShoppingBag,
} from "lucide-react";

import { Wordmark, WORDMARK_LINK } from "@/components/Wordmark";
import { CurrencySwitcher } from "@/components/CurrencySwitcher";
import { HeaderTokenBalance } from "@/components/HeaderTokenBalance";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { SettingsMenu } from "@/components/SettingsMenu";
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
  radio: Radio,
  packages: Clapperboard,
} as const;

/** Language + currency — always visible (never `md:hidden` / `lg:hidden`). */
function LocaleControls({ className = "" }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-l border-zinc-700/80 pl-3",
        className,
      )}
      data-no-translate
    >
      <LanguageSwitcher menuAlign="end" />
      <CurrencySwitcher variant="pill" />
    </div>
  );
}

/** Right-side desktop/mobile header actions: tokens, locale, settings. */
function HeaderActions({ className = "" }: { className?: string }) {
  return (
    <div className={cn("ms-auto flex shrink-0 items-center justify-end gap-2 sm:gap-3", className)}>
      <HeaderTokenBalance />
      <LocaleControls />
      <SettingsMenu />
    </div>
  );
}

function NavItem({
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
  const className = compact
    ? cn(
        "flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-none border border-zinc-700 bg-zinc-900 px-1 py-1.5 outline-none transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-red-500",
        isCreate && "nav-create-glow border-red-500",
        active && !isCreate && "border-white/70 bg-zinc-800",
        active && isCreate && "bg-zinc-800",
      )
    : cn(
        "flex min-h-11 items-center gap-3 rounded-none border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-red-500",
        isCreate && "nav-create-glow border-red-500",
        active && "bg-zinc-800",
      );
  const label = (
    <>
      <Icon
        className={cn(
          "rwb-nav-icon shrink-0",
          compact ? "size-4" : "size-[18px]",
        )}
        aria-hidden
      />
      <span
        className={cn(
          "rwb-flame rwb-flame-deep font-mono font-bold uppercase",
          compact
            ? "max-w-full truncate text-center text-[9px] tracking-[0.08em]"
            : "min-w-0 text-start text-[11px] tracking-[0.16em]",
        )}
      >
        {compact ? item.short : item.label}
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

  if (item.to === "/" && item.hash === "radio") {
    return (
      <Link to="/" hash="radio" className={className} aria-current={active ? "page" : undefined}>
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
          <NavItem
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
      {/* Desktop + mobile: language/currency stay in this always-visible action group */}
      <HeaderActions className="flex" />
    </header>
  );
}

function SiteDock() {
  const { pathname, search, hash } = useActiveNav();

  return (
    <nav
      data-site-nav="dock"
      aria-label="Primary"
      className="site-dock pointer-events-auto fixed inset-x-0 bottom-0 z-30 rounded-none border-t border-white/10 bg-black/80 px-1 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] lg:hidden"
    >
      <div className="grid grid-cols-5 items-stretch gap-1">
        {SITE_NAV.map((item) => (
          <NavItem
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
