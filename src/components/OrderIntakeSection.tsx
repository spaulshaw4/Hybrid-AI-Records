import { useEffect, useRef, useState } from "react";
import { QuickOrderForm } from "@/components/QuickOrderForm";
import { PACKAGE_SLUGS, type OrderPackage } from "@/lib/order-link";

/** First real intake control — must match QuickOrderForm's artist field id. */
const FIRST_ORDER_FIELD_ID = "qo-artist";

/**
 * Distribution intake form for `/portal#order`. Owns deep-link scroll/focus and
 * Escape-to-CTA behavior so the home page never mounts this UI.
 */
export function OrderIntakeSection() {
  const [scrollAnnouncement, setScrollAnnouncement] = useState("");
  const orderCtaRef = useRef<HTMLAnchorElement>(null);
  const orderReturnFocusRef = useRef<HTMLElement | null>(null);
  const orderPushedRef = useRef(false);
  /** Bumps to cancel in-flight focus-settle loops when Escape restores the CTA. */
  const focusGenRef = useRef(0);
  /** Bumps to cancel in-flight scroll-correction loops. */
  const scrollGenRef = useRef(0);

  const headerOffset = () => {
    const header = document.querySelector("header");
    return (header instanceof HTMLElement ? header.offsetHeight : 64) + 12;
  };

  const orderScrollTarget = (el: HTMLElement) =>
    Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY - headerOffset()));

  const firstOrderField = () =>
    (document.getElementById(FIRST_ORDER_FIELD_ID) as HTMLElement | null) ??
    document
      .getElementById("quick-order-form")
      ?.querySelector<HTMLElement>(
        "input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled])",
      ) ??
    null;

  const scrollOrderIntoView = (anchor: HTMLElement, behavior: ScrollBehavior) => {
    const gen = ++scrollGenRef.current;
    window.scrollTo({ top: orderScrollTarget(anchor), behavior });

    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      for (const ev of ["wheel", "touchstart"] as const) {
        window.removeEventListener(ev, cancel);
      }
    };
    // Only user pan/scroll cancels correction. Do not listen for keydown —
    // focus handoff and Escape dismiss both synthesize keyboard activity and
    // were aborting the deep-link scroll before the field cleared the fold.
    for (const ev of ["wheel", "touchstart"] as const) {
      window.addEventListener(ev, cancel, { once: true, passive: true });
    }

    const started = performance.now();
    const correct = () => {
      if (cancelled || gen !== scrollGenRef.current || !anchor.isConnected) return cancel();
      const want = orderScrollTarget(anchor);
      const drift = Math.abs(window.scrollY - want);
      if (drift > 2) window.scrollTo({ top: want, behavior: "auto" });
      if (performance.now() - started < 3200) window.requestAnimationFrame(correct);
      else cancel();
    };
    window.setTimeout(() => window.requestAnimationFrame(correct), behavior === "smooth" ? 450 : 0);
  };

  const jumpToOrderForm = (updateHash = true, pkg?: OrderPackage, instant = false, waitFrames = 180) => {
    const form = document.getElementById("quick-order-form");
    const field = firstOrderField();
    if (!form || !field) {
      // Portal content can paint late on cold CI / Vite first-compile loads
      // (~3s at 60fps). Keep retrying until Escape/back leaves #order.
      if (waitFrames <= 0) return;
      window.requestAnimationFrame(() => {
        // Abort if Escape/back already left #order while we were waiting to mount.
        if (!updateHash && window.location.hash !== "#order") return;
        jumpToOrderForm(updateHash, pkg, instant, waitFrames - 1);
      });
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !form.contains(active)) {
      orderReturnFocusRef.current = active;
    }
    if (updateHash) {
      const url = new URL(window.location.href);
      if (pkg) url.searchParams.set("package", PACKAGE_SLUGS[pkg]);
      const next = `${url.pathname}${url.search}#order`;
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
        window.history.pushState(null, "", next);
        orderPushedRef.current = true;
      }
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Scroll the artist field itself (not the form chrome) so sticky-header
    // clearance assertions stay stable when the CTA/heading sit above the form.
    scrollOrderIntoView(field, reduced || instant ? "auto" : "smooth");

    const gen = ++focusGenRef.current;
    let attempts = 0;
    // ~3s of rAF retries so throttled CI CPUs still win against late layout.
    const maxFocusAttempts = 180;
    const settle = () => {
      if (gen !== focusGenRef.current) return;
      const el = firstOrderField();
      if (!el) {
        if (++attempts < maxFocusAttempts) window.requestAnimationFrame(settle);
        return;
      }
      if (document.activeElement === el) return;
      el.focus({ preventScroll: true });
      if (++attempts < maxFocusAttempts) window.requestAnimationFrame(settle);
    };
    window.requestAnimationFrame(settle);

    setScrollAnnouncement("");
    window.requestAnimationFrame(() =>
      setScrollAnnouncement("Order form. Press Escape to return to the Connect and Order button."),
    );
  };

  const restoreOrderFocus = (announce = false, force = false) => {
    // Cancel any settle loop that would steal focus back onto the first field.
    focusGenRef.current += 1;
    scrollGenRef.current += 1;
    const form = document.getElementById("quick-order-form");
    const active = document.activeElement as HTMLElement | null;
    // When dismissing (#order → Escape / Back), always return to the opener CTA.
    // The non-force path only skips if focus already left the form (user tabbed away).
    if (!force && active && active !== document.body && form && !form.contains(active)) return;
    const target = orderReturnFocusRef.current ?? orderCtaRef.current;
    if (!target || !target.isConnected) return;
    const focusCta = () => {
      if (!target.isConnected) return;
      target.focus({ preventScroll: true });
    };
    focusCta();
    // Win races against QuickOrderForm's popstate focus restore (rAF) and late
    // layout/focus effects on slower CI runners.
    window.requestAnimationFrame(() => {
      focusCta();
      window.requestAnimationFrame(focusCta);
    });
    window.setTimeout(focusCta, 50);
    window.setTimeout(focusCta, 120);
    if (announce) {
      setScrollAnnouncement("");
      window.requestAnimationFrame(() =>
        setScrollAnnouncement("Left the order form. Focus returned to the Connect and Order button."),
      );
    }
  };

  useEffect(() => {
    let first = true;
    const handle = () => {
      if (window.location.hash === "#order") {
        const instant = first;
        first = false;
        window.requestAnimationFrame(() => jumpToOrderForm(false, undefined, instant));
      } else {
        first = false;
        restoreOrderFocus(true, true);
      }
    };
    handle();
    const onLoad = () => {
      if (window.location.hash !== "#order") return;
      const field = firstOrderField();
      const form = document.getElementById("quick-order-form");
      if (field) scrollOrderIntoView(field, "auto");
      else if (form) scrollOrderIntoView(form, "auto");
    };
    if (document.readyState !== "complete") window.addEventListener("load", onLoad, { once: true });
    window.addEventListener("hashchange", handle);
    window.addEventListener("popstate", handle);
    return () => {
      window.removeEventListener("load", onLoad);
      window.removeEventListener("hashchange", handle);
      window.removeEventListener("popstate", handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onOrderFormKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    // Cancel in-flight field focus immediately so Escape cannot lose the race.
    focusGenRef.current += 1;
    scrollGenRef.current += 1;
    if (window.location.hash === "#order" && orderPushedRef.current) {
      orderPushedRef.current = false;
      window.history.back();
      // popstate restores focus; also schedule a late pass in case another
      // listener re-focuses a form field on the same tick.
      window.requestAnimationFrame(() => restoreOrderFocus(true, true));
      return;
    }
    if (window.location.hash === "#order") {
      const url = new URL(window.location.href);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    }
    restoreOrderFocus(true, true);
  };

  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {scrollAnnouncement}
      </div>

      <section
        id="order"
        aria-labelledby="order-title"
        className="relative scroll-mt-20 border-t border-border pt-10"
        onKeyDown={onOrderFormKeyDown}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2
              id="order-title"
              tabIndex={-1}
              className="rwb-flame rwb-flame-deep font-display text-[clamp(1.75rem,5vw,3rem)] font-extrabold tracking-tight outline-none"
            >
              Connect & Order
            </h2>
            <p className="mt-3 max-w-2xl text-base text-slate-300">
              Share your demo link and package choice. We&apos;ll confirm by email with a reference
              code you can track anytime.
            </p>
          </div>
          <a
            ref={orderCtaRef}
            href="/portal#order"
            aria-controls="quick-order-form"
            className="btn-primary shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            onClick={(e) => {
              e.preventDefault();
              jumpToOrderForm();
            }}
          >
            Connect & Order
          </a>
        </div>
        <div className="mt-10">
          <QuickOrderForm />
        </div>
      </section>
    </>
  );
}
