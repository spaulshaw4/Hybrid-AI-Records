import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  AudioLines,
  Clapperboard,
  CreditCard,
  Disc3,
  Film,
  Library,
  Radio,
  Settings,
  ShoppingBag,
  Sparkles,
  X,
} from "lucide-react";

import { Footer } from "@/components/Footer";
import { HeaderTokenBalance } from "@/components/HeaderTokenBalance";
import { Wordmark, WORDMARK_LINK } from "@/components/Wordmark";
import { CurrencySwitcher } from "@/components/CurrencySwitcher";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { SettingsMenu } from "@/components/SettingsMenu";
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

const GEAR_BUTTON =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-zinc-900/70 text-zinc-400 backdrop-blur-xl transition-all duration-200 hover:border-white/[0.15] hover:bg-zinc-900/80 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d2e] focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:pointer-events-none";

/**
 * Phone sheet for the same language and currency controls the header shows from sm up.
 * The overlay covers the page so the pickers stay usable under the fixed chrome.
 */
function MobileLocaleSheet() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={`${GEAR_BUTTON} sm:hidden`}
        aria-label="Site settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "mobile-locale-sheet" : undefined}
        onClick={() => setOpen(true)}
      >
        <Settings className="size-3.5" aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              id="mobile-locale-sheet"
              className="fixed inset-0 z-50 bg-zinc-950/95 p-6 pt-[calc(1.5rem+env(safe-area-inset-top))]"
              role="presentation"
              onClick={() => setOpen(false)}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="mobile-locale-title"
                className="mx-auto flex w-full max-w-md flex-col gap-6"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 id="mobile-locale-title" className="font-display text-xl font-semibold text-white">
                    Language and currency
                  </h2>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setOpen(false)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.08] text-zinc-200"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </div>
                <div className="flex flex-col items-start gap-3">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-400">Language</p>
                  <LanguageSwitcher menuAlign="start" />
                </div>
                <div className="flex flex-col items-start gap-3">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-400">Currency</p>
                  <CurrencySwitcher variant="pill" />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Plan, spendable tokens, language, currency, settings.
 * Static inline flow only — never fixed/sticky.
 * Below sm, language and currency move into the settings gear sheet.
 */
export function LocaleCluster({ className = "" }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex h-auto min-h-9 min-w-0 max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1.5",
        className,
      )}
      data-no-translate
    >
      <HeaderTokenBalance />
      <span className="hidden h-4 w-px shrink-0 bg-zinc-800 sm:block" aria-hidden="true" />
      <div className="hidden items-center gap-3 sm:flex">
        <LanguageSwitcher menuAlign="end" />
        <CurrencySwitcher variant="pill" />
      </div>
      <span className="hidden h-4 w-px shrink-0 bg-zinc-800 sm:block" aria-hidden="true" />
      <MobileLocaleSheet />
      <div className="hidden sm:inline-flex">
        <SettingsMenu />
      </div>
      <span className="h-4 w-px shrink-0 bg-zinc-800" aria-hidden="true" />
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
        "flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-none border border-white/[0.08] bg-zinc-900/70 px-1 py-1.5 outline-none transition-all duration-200 hover:border-white/[0.15] hover:bg-zinc-900/80 focus-visible:ring-2 focus-visible:ring-red-500",
        isCreate && "nav-create-glow border-red-500",
        active && !isCreate && "border-white/70 bg-zinc-800",
        active && isCreate && "bg-zinc-800",
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
          "rwb-flame rwb-flame-deep font-mono font-bold uppercase",
          compact
            ? "whitespace-nowrap text-center text-[10px] leading-none tracking-tight"
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
        "flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-xs tracking-wider",
        compact && "min-h-12 flex-col justify-center gap-0.5 px-1 py-1.5 text-center text-[10px] leading-none tracking-tight",
        active ? PORTAL_TAB_ACTIVE : PORTAL_TAB_IDLE,
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          active && "text-red-400 drop-shadow-[0_0_6px_rgba(239,68,68,0.8)]",
        )}
        aria-hidden
      />
      <span className="min-w-0 leading-snug">{visible}</span>
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

/** Mobile-only top bar: crest on the left, locale controls on the right. */
function SiteHeader() {
  return (
    <header
      data-site-nav="header"
      className="site-topbar pointer-events-auto fixed top-0 z-50 flex h-auto min-h-16 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1.5 overflow-visible border-b border-white/[0.08] bg-zinc-900/85 px-3 py-1.5 backdrop-blur-xl lg:hidden"
    >
      <Link
        to="/"
        aria-label="Hybrid AI Records — home"
        className={`${WORDMARK_LINK} shrink-0`}
      >
        <Wordmark size="sm" showText={false} interactive />
      </Link>
      <LocaleCluster className="ms-auto min-w-0 max-w-full flex-1" />
    </header>
  );
}

/**
 * Desktop (non-home): static in-flow locale row at the top of the main column.
 * Home places the cluster beside the hero kicker instead.
 */
function DesktopLocaleStrip() {
  const { pathname } = useActiveNav();
  // Home, catalog, and packages place LocaleCluster on the page header row instead.
  if (pathname === "/" || pathname === "/artists" || pathname === "/portal") return null;

  return (
    <div
      data-site-nav="desktop-locale"
      className="hidden h-auto min-h-16 items-center justify-end overflow-visible px-6 py-1 lg:flex"
    >
      <LocaleCluster />
    </div>
  );
}

function SiteDock() {
  const { pathname } = useActiveNav();

  return (
    <nav
      data-site-nav="dock"
      aria-label={pathname === "/portal" ? "Portal sections" : "Primary"}
      className="site-dock pointer-events-auto fixed inset-x-0 bottom-0 z-30 rounded-none border-t border-white/[0.08] bg-zinc-900/70 px-1 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] backdrop-blur-xl lg:hidden"
    >
      <div className="grid grid-cols-5 items-stretch gap-1">
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
        <DesktopLocaleStrip />
        <div className="flex-1">{children}</div>
        <Footer />
      </div>
      <SiteDock />
    </>
  );
}
