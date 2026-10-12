import type { ReactNode } from "react";

const LEGACY_COPY =
  "Foundational works preserved, mastered, and archived under the Hybrid AI Records infrastructure, featuring 'The Journey' and 'The Campfire Confessions'.";

const LEGACY_TITLES = new Set(["the journey", "campfire confessions", "the campfire confessions"]);

function legacyTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The two preserved Jester albums. Other catalog releases stay on the active roster. */
export function isJesterLegacyAlbum(album: { title: string }): boolean {
  return LEGACY_TITLES.has(legacyTitleKey(album.title));
}

/**
 * Landing keeps the division heading. The catalog passes `asCard` so the same
 * copy sits inside the Legacy Archives showcase instead of leading the page.
 */
export function JesterLegacySection({
  asCard = false,
  children,
}: {
  asCard?: boolean;
  children?: ReactNode;
}) {
  if (asCard) {
    return (
      <div className="mt-4 rounded-2xl border border-white/10 bg-zinc-950/55 p-5 sm:p-6">
        <h3 className="font-display text-xl font-semibold leading-normal text-white">
          The Jester AI Legacy Division
        </h3>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-slate-100">{LEGACY_COPY}</p>
        {children}
      </div>
    );
  }

  return (
    <section id="legacy" aria-labelledby="legacy-title" className="scroll-mt-24">
      <h2
        id="legacy-title"
        tabIndex={-1}
        className="font-display text-3xl font-extrabold leading-normal tracking-tight text-white outline-none sm:text-4xl"
      >
        The Jester AI Legacy Division
      </h2>
      <p className="mt-4 max-w-3xl text-base leading-relaxed text-slate-100">{LEGACY_COPY}</p>
    </section>
  );
}
