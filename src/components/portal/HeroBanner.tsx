/** Landing motto. The credential line lives only here. */
export function HeroBanner() {
  return (
    <div>
      <h1 className="font-extrabold tracking-tight text-4xl sm:text-5xl leading-none">
        <span className="block text-red-600 drop-shadow-[0_0_12px_rgba(239,68,68,0.4)]">
          RAW WORDS.
        </span>
        <span className="block text-white drop-shadow-[0_0_12px_rgba(255,255,255,0.3)]">
          REAL MUSIC.
        </span>
        <span className="block text-blue-500 drop-shadow-[0_0_12px_rgba(59,130,246,0.4)]">
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
