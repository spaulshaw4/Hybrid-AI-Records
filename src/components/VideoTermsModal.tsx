import { useEffect } from "react";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  packageTitle?: string;
}

const SECTIONS: { heading: string; body: string[] }[] = [
  {
    heading: "1. One-shoot deal",
    body: [
      "Video packages are sold as a one-shoot deal. The flat rate covers the production and delivery of a single finished video built from the assets you supply at checkout.",
      "There is no second shoot, no alternate cut, and no additional version included in the price. Anything beyond the one delivered video is a new, separately quoted project.",
    ],
  },
  {
    heading: "2. Zero revisions",
    body: [
      "Video packages include 0 revision rounds. Once production begins we do not re-edit, re-grade, re-time, or re-cut the video based on feedback.",
      "Because of this, your treatment, footage, stills, logo, on-screen text, and master audio must be final before you pay. Assets are locked at payment.",
      "Corrections caused by a verifiable error on our side — for example the wrong audio file being used, or a rendering fault in the delivered file — are fixed at no charge. That is a defect fix, not a revision.",
    ],
  },
  {
    heading: "3. Final delivery",
    body: [
      "Delivery is final. When the finished file (and any included social cut) is sent to the email or link on your order, the project is complete and closed.",
      "Standard Video Package: 7–10 business days from receipt of your complete asset pack. 4K HD Video Package: 10–14 business days. Timelines start when the full asset pack arrives, not at payment.",
      "You are responsible for downloading and backing up your files. Delivery links are kept live for 30 days after handoff.",
    ],
  },
  {
    heading: "4. No returns or refunds",
    body: [
      "All video sales are final. We do not offer returns, refunds, exchanges, credits, or package swaps once payment is made, because production capacity is reserved for your project immediately.",
      "Changing your mind, changing your song, or changing your creative direction after payment does not qualify for a refund. It requires a new order.",
    ],
  },
  {
    heading: "5. Rights and content",
    body: [
      "You confirm that you own or have cleared every asset you send us — audio, footage, stills, logos, and likenesses. We do not clear third-party samples or copyrighted footage on your behalf.",
      "You retain ownership of your master and your finished video. Hybrid AI Records LLC may show the finished work in its portfolio and social channels unless you ask us in writing not to.",
      "We reserve the right to decline or halt any project involving unlawful, hateful, or infringing content. In that specific case, unstarted work is refunded.",
    ],
  },
];

export function VideoTermsModal({ open, onClose, packageTitle }: Props) {
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
      aria-label="Video package terms"
      className="fixed inset-0 z-[110] flex flex-col modal-panel-solid lg:ps-[var(--site-sidebar-width)]"
      onClick={onClose}
    >
      <div
        className="relative mx-auto flex h-full w-full max-w-3xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/60 bg-white/70 px-6 py-4 backdrop-blur-md sm:px-10">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              <span className="text-[#e11d2e]">/</span> <span className="text-white">Video</span>{" "}
              <span className="text-[#4b8bff]">Terms</span>
            </div>
            <div className="mt-1 truncate font-display text-sm font-semibold text-white sm:text-base">
              {packageTitle ? `${packageTitle} — ` : ""}One-shoot deal · 0 revisions · no returns
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-10 w-10 shrink-0 place-items-center border border-border text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-10 sm:px-10 sm:py-14">
          <h2 className="font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            Video Production Terms
          </h2>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Plain language, no fine print games. Read this before you pay — by checking out on a
            video package you agree to every point below.
          </p>

          <div className="mt-10 space-y-10">
            {SECTIONS.map((section) => (
              <section key={section.heading}>
                <h3 className="font-display text-xl font-semibold text-white">{section.heading}</h3>
                <div className="mt-3 space-y-3">
                  {section.body.map((p) => (
                    <p key={p} className="text-sm leading-relaxed text-white/80">
                      {p}
                    </p>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="mt-12 border border-border-strong bg-background/40 px-6 py-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#4b8bff]">
              Questions before you pay
            </div>
            <p className="mt-2 text-sm leading-relaxed text-white/80">
              Ask first — once payment is made these terms apply in full. Reach us at{" "}
              <a
                href="mailto:info@hybrid-ai-records.com"
                className="text-[#e11d2e] underline underline-offset-4 hover:text-white"
              >
                info@hybrid-ai-records.com
              </a>
              .
            </p>
          </div>

          <div className="mt-10 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center gap-2 border border-border-strong px-6 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:border-white"
            >
              Close terms
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
