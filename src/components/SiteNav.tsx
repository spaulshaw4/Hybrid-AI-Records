import { useEffect, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  AudioLines,
  Clapperboard,
  CreditCard,
  Disc3,
  Film,
  Library,
  Radio,
  ShoppingBag,
  Sparkles,
} from "lucide-react";

import { Footer } from "@/components/Footer";
import { HeaderTokenBalance, PlanBadge } from "@/components/HeaderTokenBalance";
import { SettingsMenu } from "@/components/SettingsMenu";
import { Wordmark, WORDMARK_LINK } from "@/components/Wordmark";
import UserAuthButton from "@/components/studio/UserAuthButton";
import { cn } from "@/lib/utils";
import {
  SITE_NAV,
  isSiteNavActive,
  shouldShowSiteNav,
  type SiteNavItem,
} from "@/lib/site-nav";
import { PORTAL_MENU, resolvePortalTab, type PortalMenuIcon, type PortalTab } from "@/lib/portal-tabs";

const ICONS = {
  audio: AudioLines,
  catalog: Library,
  merch: ShoppingBag,
  radio: Radio,
  packages: Clapperboard,
} as const;

const PORTAL_ICONS: Record<PortalMenuIcon, typeof Sparkles> = {
  sparkles: Sparkles,
  disc: Disc3,
  card: CreditCard,
  radio: Radio,
  film: Film,
};

const PORTAL_TAB_ACTIVE =
  "border border-white/90 bg-zinc-900/90 text-white font-bold shadow-[0_0_12px_rgba(239,68,68,0.7),0_0_20px_rgba(59,130,246,0.6),inset_0_0_8px_rgba(255,255,255,0.4)] ring-1 ring-red-500/50";

const PORTAL_TAB_IDLE =
  "border border-transparent text-zinc-400 hover:text-white hover:bg-white/5";

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
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 py-1.5 text-zinc-400 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-red-500",
        isCreate && "text-red-400",
        active && "bg-white/10 text-white",
      )
    : cn(
        "flex min-h-11 items-center gap-3 rounded-none border border-white/[0.08] bg-zinc-900/70 px-3 py-2 outline-none transition-all duration-200 hover:border-white/[0.15] hover:bg-zinc-900/80 focus-visible:ring-2 focus-visible:ring-red-500",
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
          compact
            ? "max-w-full truncate text-center text-[10px] font-medium normal-case leading-none tracking-tight"
            : "rwb-flame rwb-flame-deep min-w-0 text-start font-mono text-[11px] font-bold uppercase tracking-[0.16em]",
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
        search={{ tab: "distribution" }}
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

function usePortalTabSelect() {
  const navigate = useNavigate();
  return (tab: PortalTab) => {
    void navigate({
      to: "/portal",
      search: (prev) => ({
        ...(prev ?? {}),
        tab,
      }),
    });
  };
}

function PortalTabButton({
  icon,
  label,
  compactLabel,
  compact,
  active,
  onSelect,
}: {
  icon: PortalMenuIcon;
  label: string;
  compactLabel: string;
  compact?: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = PORTAL_ICONS[icon];
  const visible = compact ? compactLabel : label;

  return (
    <button
      type="button"
      aria-pressed={active}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      onClick={onSelect}
      className={cn(
        compact
          ? "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 py-1.5 text-center text-[10px] font-medium leading-none tracking-tight text-zinc-400 outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-red-500"
          : "flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-xs tracking-wider",
        !compact && (active ? PORTAL_TAB_ACTIVE : PORTAL_TAB_IDLE),
        compact && active && "bg-white/10 text-white",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          active && "text-red-400 drop-shadow-[0_0_6px_rgba(239,68,68,0.8)]",
        )}
        aria-hidden
      />
      <span className={cn("min-w-0 leading-snug", compact && "max-w-full truncate")}>{visible}</span>
    </button>
  );
}

function SiteNavEntries({ compact }: { compact?: boolean }) {
  const { pathname, search, hash } = useActiveNav();
  const selectPortalTab = usePortalTabSelect();
  const onPortal = pathname === "/portal";
  const portalTab = onPortal ? resolvePortalTab(search.tab) : null;

  if (portalTab) {
    return PORTAL_MENU.map((item) => (
      <PortalTabButton
        key={item.id}
        icon={item.icon}
        label={item.label}
        compactLabel={item.short}
        compact={compact}
        active={portalTab === item.id}
        onSelect={() => selectPortalTab(item.id)}
      />
    ));
  }

  return SITE_NAV.map((item) => {
    return (
      <NavItem
        key={item.id}
        item={item}
        compact={compact}
        active={isSiteNavActive(item, pathname, search, hash)}
      />
    );
  });
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
  const { pathname } = useActiveNav();
  const onPortal = pathname === "/portal";

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
      <nav
        className="flex flex-1 flex-col gap-2 overflow-y-auto border-t-0 p-3"
        aria-label={onPortal ? "Portal sections" : undefined}
      >
        <SiteNavEntries />
      </nav>
    </aside>
  );
}

/** Fixed top bar: logo and plan, live token pill, settings and account. */
function SiteHeader() {
  return (
    <header
      data-site-nav="header"
      className="site-topbar pointer-events-auto fixed top-0 z-50 flex h-14 items-center justify-between gap-2 border-b border-white/10 bg-black/80 px-3 backdrop-blur-md"
    >
      <div className="flex min-w-0 shrink items-center gap-2">
        <Link
          to="/"
          aria-label="Hybrid AI Records — home"
          className={`${WORDMARK_LINK} shrink-0`}
        >
          <Wordmark size="sm" showText={false} interactive />
        </Link>
        <PlanBadge />
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
  const { pathname } = useActiveNav();

  return (
    <nav
      data-site-nav="dock"
      aria-label={pathname === "/portal" ? "Portal sections" : "Primary"}
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
      <div className="site-chrome-content flex min-h-screen flex-col bg-transparent">
        <div className="flex-1">{children}</div>
        <Footer />
      </div>
      <MobileNav />
    </>
  );
}
