import { MERCH_URL } from "@/lib/site-nav";

/** Official Printful store. Printful blocks iframes, so this is a direct link. */
export function MerchView() {
  return (
    <section aria-labelledby="portal-merch" className="mt-10">
      <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-zinc-900 via-black to-zinc-950 px-6 py-10 sm:px-10">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-red-500">
          Hybrid AI Records
        </p>
        <h2
          id="portal-merch"
          className="portal-page-title mt-3 font-display text-3xl font-bold tracking-tight text-white sm:text-4xl"
        >
          Merch
        </h2>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          The Hybrid AI Records store is hosted on Printful.
        </p>
        <a
          href={MERCH_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 w-full block py-3.5 text-center font-bold tracking-wider uppercase bg-red-600 hover:bg-red-500 text-white rounded-lg transition-all"
        >
          Open Merch Store ↗
        </a>
      </div>
    </section>
  );
}
