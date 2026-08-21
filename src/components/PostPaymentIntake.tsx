import { useState } from "react";
import type { ServicePackage } from "@/lib/services";
import { ArtistFileDrop } from "@/components/ArtistFileDrop";
import { VideoPrepChecklist } from "@/components/VideoPrepChecklist";
import { VocalSessionScheduler } from "@/components/VocalSessionScheduler";
import { LyricsSubmissionForm } from "@/components/LyricsSubmissionForm";

/**
 * Post-payment project intake.
 *
 * Checkout only asks for a name, an email and the payment. Everything else —
 * files, links, treatment notes, vocal sessions — is collected here, on the
 * success screen, once the customer has already bought.
 */
export function PostPaymentIntake({
  pkg,
  reference,
  className = "",
}: {
  pkg?: ServicePackage | null;
  reference?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const isVideo = pkg?.kind === "video";

  return (
    <section
      aria-labelledby="post-payment-intake"
      className={`border border-border bg-background/50 p-6 text-start ${className}`}
    >
      <h2
        id="post-payment-intake"
        className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
      >
        Next — your project details
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-white/80">
        Payment is done{reference ? ` (reference ${reference})` : ""}. Send us what you have
        whenever you're ready — nothing here blocks your order, and you can come back to this from
        your order status page.
      </p>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-4 inline-flex items-center gap-2 border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-white/10"
      >
        {open ? "Hide project details" : "Add project details"}
      </button>

      {open ? (
        <div className="mt-6 space-y-8">
          <div>
            <h3 className="font-display text-lg font-semibold text-white">
              {isVideo ? "Send video assets" : "Send files"}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {isVideo
                ? "Upload your final master audio (WAV or 320kbps MP3), footage or stills for the cut, your logo, and a short treatment or shot list."
                : "Upload stems, reference tracks, lyrics, or revision notes straight to the studio inbox."}
            </p>
            <div className="mt-4">
              <ArtistFileDrop kind={isVideo ? "video" : "audio"} />
            </div>
          </div>

          {isVideo ? <VideoPrepChecklist /> : null}

          {pkg?.startOptions?.length ? (
            <>
              <VocalSessionScheduler pkg={pkg} />
              <LyricsSubmissionForm pkg={pkg} />
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
