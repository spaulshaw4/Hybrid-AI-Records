import { MERCH_URL } from "@/lib/site-nav";

/** Official Printful store. There is no in-app product catalog. */
export function MerchView() {
  return (
    <section aria-labelledby="portal-merch" className="mt-10">
      <h2 id="portal-merch" className="portal-page-title font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
        Merch
      </h2>
      <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
        The Hybrid AI Records store is hosted on Printful.
      </p>
      <a
        href={MERCH_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-6 inline-flex items-center gap-2 border border-white/15 bg-white/[0.03] px-6 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white/80 transition-colors hover:border-white/35 hover:text-white"
      >
        OPEN MERCH STORE ↗
      </a>
    </section>
  );
}
