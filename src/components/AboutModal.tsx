import { useEffect } from "react";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SECTIONS: { eyebrow: string; heading: string; body: string[] }[] = [
  {
    eyebrow: "Part I",
    heading: "The Obsession with Sound",
    body: [
      "Music has never been a background distraction or passive entertainment for me—it has been a foundational pillar of my life. Long before there was ever a company name, a label infrastructure, or a business plan, there was just the raw power of sound. Heavy riffs, unyielding rhythms, and lyrics that cut straight to the bone.",
      "For as long as I can remember, I've viewed music as the ultimate translator of human experience. It captures things regular conversation can't reach: the unspoken weight you carry, the grit it takes to keep pushing forward, and the quiet realizations that hit you in the middle of the night.",
      "Because of that passion, I was constantly writing. Notebook after notebook filled up with verse structures, chorus ideas, album concepts, and raw lyrical lines. To me, every page wasn't just text—it was a sound waiting to happen. I could hear the aggression in the drums, the space in the arrangement, and the emotional impact the track was supposed to deliver.",
      "The words were alive on paper. But keeping them locked on paper was never going to be enough.",
    ],
  },
  {
    eyebrow: "Part II",
    heading: "The Wall Every Independent Creator Hits",
    body: [
      "When you have a notebook full of songs, you quickly learn the hardest truth in the music industry: the distance between a written page and a finished, studio-grade 10-track album is a massive, unforgiving wall.",
      "The traditional path is intentionally built to gatekeep creators who don't fit into a corporate box or carry massive bank accounts:",
      "The Financial Barrier: Renting legitimate studio time, hiring session musicians, paying audio engineers by the hour, and funding professional mixing and mastering can easily cost tens of thousands of dollars for a single album project.",
      "The Technical Barrier: If you aren't already an expert in complex Digital Audio Workstations (DAWs), audio synthesis, frequency carving, and master bus processing, your raw recordings will sound thin, amateur, and uncompetitive on streaming services.",
      "The Industry Trap: Traditional record labels prey on this exact gap. They promise to turn your ideas into finished records, but in exchange, they demand your master rights, take control of your creative direction, and swallow 80% to 90% of your long-term royalties.",
      "I hit that wall repeatedly. I saw how exhausting it was to watch powerful, meaningful ideas sit stagnant on paper simply because the traditional pipeline was too slow, too expensive, and structurally rigged against the independent artist.",
      "Too many incredible stories die in closed notebooks because the author didn't have fifty grand or a corporate label deal to bring them to life. I refused to let my work suffer that fate—and I knew I wasn't the only one suffering through that exact same frustration.",
    ],
  },
  {
    eyebrow: "Part III",
    heading: "The Spark of Hybrid AI Records LLC",
    body: [
      "Instead of accepting a broken system, I decided to build a new engine entirely.",
      "We stand at a historic turning point in audio technology. For the first time in history, advanced AI audio generation and synthesis can pair directly with human storytelling, raw vocals, and precise artistic direction. The machine doesn't replace the human heart—it empowers it. It acts as the ultimate amplifier for the person who has the lyrics, the vision, and the drive, but lacked the massive studio budget to execute it.",
      "That realization birthed Hybrid AI Records LLC.",
      "I didn't launch this label to play corporate games or collect shelf space. I built it as a direct bridge for the independent creator—a streamlined, high-output production house designed to take a writer's vision straight off the physical page and turn it into release-ready master audio and cinematic visual videos.",
    ],
  },
  {
    eyebrow: "Part IV",
    heading: "Our Uncompromising Code",
    body: [
      "Hybrid AI Records LLC operates on a completely different set of principles than the legacy music industry. We don't take your rights, and we don't hide behind confusing corporate fine print.",
      "100% ARTIST OWNERSHIP + FULL-SCALE ALBUM PRODUCTION = TRUE INDEPENDENCE",
      "1. You Keep 100% of Your Royalties & Ownership — Your music is your intellectual property. Period. We build your production, format your album, execute your visual videos, and handle distribution—but you retain 100% of your master rights and earnings. We don't steal your hard work under the guise of 'label backing.'",
      "2. Complete 10-Track Album Executions — We don't deal in disposable, one-off distractions. We focus on complete, cohesive bodies of work. Whether you come to us with a single vocal line or a full binder of lyrics, our job is to construct a full 10-track album project that holds up sonically against anything on the market today.",
      "3. Integrated Visual Media — In the modern world, sound and vision are inseparable. For complete album builds, we deliver official music videos upon project completion so your project doesn't just hit the speakers—it leaves a lasting visual mark.",
    ],
  },
  {
    eyebrow: "Part V",
    heading: "From Paper to the World",
    body: [
      "Hybrid AI Records LLC exists for the artist who has something real to say and refuses to be sidelined by the traditional industry's price tag or gatekeepers.",
      "If you have notebooks full of lyrics, concepts that keep you up at night, or a story that demands to be heard across every major streaming platform in the world, you no longer have to wait for permission or a million-dollar contract.",
      "Bring your words. Bring your vision. We'll build the sound.",
      "Welcome to Hybrid AI Records LLC.",
    ],
  },
];

export function AboutModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="About Hybrid AI Records"
      className="fixed inset-0 z-[110] flex flex-col modal-panel-solid lg:ps-[var(--site-sidebar-width)]"
      onClick={onClose}
    >
      <div
        className="relative mx-auto flex h-full w-full max-w-3xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.08] bg-zinc-900/80 px-6 py-4 backdrop-blur-xl sm:px-10">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              <span className="text-[#e11d2e]">/</span>{" "}
              <span className="text-white">About</span>{" "}
              <span className="text-[#4b8bff]">Hybrid AI Records</span>
            </div>
            <div className="mt-1 truncate font-display text-sm font-semibold sm:text-base">
              The Story of Hybrid AI Records LLC
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close about"
            className="grid h-10 w-10 shrink-0 place-items-center border border-border text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-10 sm:px-10 sm:py-14">
          <header className="border-b border-border pb-10">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              <span className="text-[#e11d2e]">HYBRID</span>{" "}
              <span className="text-white">AI</span>{" "}
              <span className="text-[#4b8bff]">RECORDS LLC</span>
            </div>
            <h2 className="mt-4 font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl md:text-5xl">
              The Story of Hybrid AI Records LLC
            </h2>
            <p className="mt-4 font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
              From the Ink on the Page to the Final Master
            </p>
          </header>

          <div className="space-y-12 pt-10">
            {SECTIONS.map((s) => (
              <section key={s.eyebrow} className="border-b border-border/60 pb-10 last:border-b-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#e11d2e]">
                  {s.eyebrow}
                </div>
                <h2 className="mt-3 font-display text-2xl font-semibold leading-tight tracking-tight text-white sm:text-3xl">
                  {s.heading}
                </h2>
                <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-muted-foreground sm:text-base sm:leading-[1.75]">
                  {s.body.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="mt-12 flex justify-center">
            <button
              type="button"
              onClick={onClose}
              className="border border-white px-8 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-black"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
