import { useEffect, useRef, useState } from "react";
import { QuickOrderForm } from "@/components/QuickOrderForm";
import { PACKAGE_SLUGS, type OrderPackage } from "@/lib/order-link";

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

  const headerOffset = () => {
    const header = document.querySelector("header");
    return (header instanceof HTMLElement ? header.offsetHeight : 64) + 12;
  };

  const orderScrollTarget = (form: HTMLElement) =>
    Math.max(0, Math.round(form.getBoundingClientRect().top + window.scrollY - headerOffset()));

  const scrollOrderIntoView = (form: HTMLElement, behavior: ScrollBehavior) => {
    window.scrollTo({ top: orderScrollTarget(form), behavior });

    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      for (const ev of ["wheel", "touchstart", "keydown"] as const) {
        window.removeEventListener(ev, cancel);
      }
    };
    for (const ev of ["wheel", "touchstart", "keydown"] as const) {
      window.addEventListener(ev, cancel, { once: true, passive: true });
    }

    const started = performance.now();
    const correct = () => {
      if (cancelled || !form.isConnected) return cancel();
      const want = orderScrollTarget(form);
      const drift = Math.abs(window.scrollY - want);
      if (drift > 2) window.scrollTo({ top: want, behavior: "auto" });
      if (performance.now() - started < 2600) window.requestAnimationFrame(correct);
      else cancel();
    };
    window.setTimeout(() => window.requestAnimationFrame(correct), behavior === "smooth" ? 450 : 0);
  };

  const jumpToOrderForm = (updateHash = true, pkg?: OrderPackage, instant = false) => {
    const form = document.getElementById("quick-order-form");
    if (!form) return;
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
    scrollOrderIntoView(form, reduced || instant ? "auto" : "smooth");
    const first = form.querySelector<HTMLElement>(
      "input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled])",
    );
    if (first) {
      const gen = ++focusGenRef.current;
      let attempts = 0;
      const settle = () => {
        if (gen !== focusGenRef.current) return;
        if (document.activeElement === first) return;
        first.focus({ preventScroll: true });
        if (++attempts < 60) window.requestAnimationFrame(settle);
      };
      window.requestAnimationFrame(settle);
    }

    setScrollAnnouncement("");
    window.requestAnimationFrame(() =>
      setScrollAnnouncement("Order form. Press Escape to return to the Connect and Order button."),
    );
  };

  const restoreOrderFocus = (announce = false) => {
    // Cancel any settle loop that would steal focus back onto the first field.
    focusGenRef.current += 1;
    const form = document.getElementById("quick-order-form");
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && form && !form.contains(active)) return;
    const target = orderReturnFocusRef.current ?? orderCtaRef.current;
    if (!target || !target.isConnected) return;
    const focusCta = () => {
      if (!target.isConnected) return;
      target.focus({ preventScroll: true });
    };
    focusCta();
    // Win races against QuickOrderForm's popstate focus restore (rAF).
    window.requestAnimationFrame(() => {
      focusCta();
      window.requestAnimationFrame(focusCta);
    });
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
        restoreOrderFocus(true);
      }
    };
    handle();
    const onLoad = () => {
      if (window.location.hash !== "#order") return;
      const form = document.getElementById("quick-order-form");
      if (form) scrollOrderIntoView(form, "auto");
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
    if (window.location.hash === "#order" && orderPushedRef.current) {
      orderPushedRef.current = false;
      window.history.back();
      // popstate restores focus; also schedule a late pass in case another
      // listener re-focuses a form field on the same tick.
      window.requestAnimationFrame(() => restoreOrderFocus(true));
      return;
    }
    if (window.location.hash === "#order") {
      const url = new URL(window.location.href);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    }
    restoreOrderFocus(true);
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
