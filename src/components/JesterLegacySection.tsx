/** Catalog copy for the preserved Jester projects. The two named works stay in the album catalog. */
export function JesterLegacySection() {
  return (
    <section id="legacy" aria-labelledby="legacy-title" className="scroll-mt-24">
      <h2
        id="legacy-title"
        tabIndex={-1}
        className="font-display text-3xl font-extrabold tracking-tight text-white outline-none sm:text-4xl"
      >
        The Jester AI Legacy Division
      </h2>
      <p className="mt-4 max-w-3xl text-base leading-relaxed text-slate-100">
        {`Foundational works preserved, mastered, and archived under the Hybrid AI Records infrastructure, featuring 'The Journey' and 'The Campfire Confessions'.`}
      </p>
    </section>
  );
}
