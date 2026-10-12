/** Landing motto. The credential line lives only here. */
export function HeroBanner() {
  return (
    <div>
      <h1 className="text-4xl font-black uppercase leading-none tracking-tight md:text-6xl">
        <span className="hero-line-white block">RAW WORDS.</span>
        <span className="hero-line-red block">REAL MUSIC.</span>
        <span className="hero-line-blue block">GLOBAL IMPACT.</span>
      </h1>
      <p className="mt-4 flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-zinc-400 md:text-xs">
        <span
          className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-600"
          aria-hidden="true"
        />
        Independent • SBA Veteran-Certified • Knoxville, TN
      </p>
    </div>
  );
}
