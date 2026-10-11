/** Landing motto. The credential line lives only here. */
export function HeroBanner() {
  return (
    <div>
      <h1 className="text-4xl font-black uppercase leading-none tracking-tight text-white md:text-6xl">
        <span className="block">RAW WORDS.</span>
        <span
          className="block text-red-500 drop-shadow-[0_0_15px_rgba(239,68,68,0.8)]"
          style={{ color: "#ef4444", WebkitTextFillColor: "#ef4444" }}
        >
          REAL MUSIC.
        </span>
        <span className="block" style={{ WebkitTextFillColor: "#ffffff" }}>
          GLOBAL IMPACT.
        </span>
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
