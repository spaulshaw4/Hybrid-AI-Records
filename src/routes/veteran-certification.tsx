import { useEffect } from "react";
import { pageHead } from "@/lib/social-meta";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Lock, ShieldCheck } from "lucide-react";
import affidavitPage1 from "@/assets/vetcert-affidavit-page-1.jpg";

export const Route = createFileRoute("/veteran-certification")({
  head: () =>
    pageHead({
      path: "/veteran-certification",
      title: "Veteran-Owned Certification — Hybrid AI Records",
      description: "View-only affidavit of veteran ownership for Hybrid AI Records LLC, an officially certified Veteran-Owned Small Business (SBA VetCert).",
      socialTitle: "Veteran-Owned Certification — Hybrid AI Records",
      socialDescription: "Officially certified Veteran-Owned Small Business (SBA VetCert). Affidavit of veteran ownership, view-only.",
      type: "article",
      card: "summary_large_image",
    }),
  component: VeteranCertificationPage,
});

function VeteranCertificationPage() {
  // Block the browser/OS shortcuts that would save, print, or export the page.
  useEffect(() => {
    const blockedKeys = new Set(["s", "p", "u", "g"]);
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && blockedKeys.has(e.key.toLowerCase())) {
        e.preventDefault();
        e.stopPropagation();
      }
      // Safari "Save Page As" and DevTools shortcuts.
      if (mod && e.shiftKey && ["s", "i", "c", "j"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (e.key === "F12") e.preventDefault();
    };
    const block = (e: Event) => e.preventDefault();

    window.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("contextmenu", block);
    document.addEventListener("copy", block);
    document.addEventListener("cut", block);
    document.addEventListener("dragstart", block);
    // Print dialogs opened from the browser menu still get a blank page via CSS,
    // and this cancels any programmatic print attempt.
    const onBeforePrint = () => window.stop?.();
    window.addEventListener("beforeprint", onBeforePrint);

    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true } as EventListenerOptions);
      document.removeEventListener("contextmenu", block);
      document.removeEventListener("copy", block);
      document.removeEventListener("cut", block);
      document.removeEventListener("dragstart", block);
      window.removeEventListener("beforeprint", onBeforePrint);
    };
  }, []);

  return (
    <main className="min-h-dvh bg-background/40 px-4 py-12 backdrop-blur-sm sm:px-6">
      <style>{`
        @media print {
          html, body { display: none !important; visibility: hidden !important; }
        }
        .no-print-doc {
          -webkit-user-select: none;
          user-select: none;
          -webkit-touch-callout: none;
          -webkit-user-drag: none;
        }
        .no-print-doc::selection { background: transparent; }
        /* The affidavit is painted as a background layer: there is no <img>
           element to "Save image as", copy, or drag out of the page. */
        .vetcert-doc {
          background-image: var(--vetcert-src);
          background-size: contain;
          background-position: center;
          background-repeat: no-repeat;
          aspect-ratio: 1241 / 1754;
          pointer-events: none;
        }
      `}</style>

      <div className="mx-auto w-full max-w-3xl">
        <Link
          to="/"
          className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
          Back to Hybrid AI Records
        </Link>

        <header className="mt-8 border border-veteran-gold/30 bg-veteran-gold/5 p-6">
          <p className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-veteran-gold sm:text-[11px]">
            <ShieldCheck size={14} strokeWidth={1.75} aria-hidden />
            Officially Certified Veteran-Owned Small Business (SBA VetCert)
          </p>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Affidavit of Veteran Ownership
          </h1>
          <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
            Hybrid AI Records LLC is a certified Veteran-Owned Small Business.
            The certification document is published here for verification only.
          </p>
        </header>

        <aside
          role="note"
          aria-label="Printing and download restrictions"
          className="mt-4 flex items-start gap-3 border border-primary/40 bg-primary/10 p-4"
        >
          <Lock
            size={18}
            strokeWidth={1.75}
            aria-hidden
            className="mt-0.5 shrink-0 text-primary"
          />
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary sm:text-[11px]">
              Printing &amp; downloading are disabled
            </p>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-foreground/80">
              This affidavit contains official SBA VetCert ownership
              information. To prevent unauthorized reproduction, forgery, or
              misuse of our certification, the document is published as a
              view-only record — printing, saving, copying, and downloading are
              blocked. If you need a verifiable copy for procurement or
              compliance, contact Hybrid AI Records directly and we will send an
              official certified copy.
            </p>
          </div>
        </aside>


        <section
          aria-label="Affidavit of veteran ownership, view only"
          className="no-print-doc relative mt-8 border border-border bg-card p-2"
          onContextMenu={(e) => e.preventDefault()}
          onDragStart={(e) => e.preventDefault()}
        >
          <div
            role="img"
            aria-label="Affidavit of veteran ownership for Hybrid AI Records LLC, certified Veteran-Owned Small Business"
            className="vetcert-doc w-full select-none"
            style={{ ["--vetcert-src" as string]: `url(${affidavitPage1})` }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <span className="rotate-[-24deg] font-mono text-3xl uppercase tracking-[0.3em] text-veteran-gold/15 sm:text-5xl">
              View Only
            </span>
          </div>
        </section>

        <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
          For certification verification requests, contact Hybrid AI Records
          directly. Reproduction, printing, or redistribution of this document
          is not permitted.
        </p>
      </div>
    </main>
  );
}
