import { Scale, ShieldAlert, FileWarning, Copyright, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface LegalDisclaimerProps {
  /** Use "compact" for a shorter version in the footer; "full" for the engine page. */
  variant?: "full" | "compact";
  /** Bare layout removes the outer border/background and inner max-width for embedding inside cards. */
  bare?: boolean;
  className?: string;
}

export function LegalDisclaimer({ variant = "full", bare = false, className = "" }: LegalDisclaimerProps) {
  const isCompact = variant === "compact";
  const toggleId = isCompact ? "disclaimer-toggle-compact" : "disclaimer-toggle";


  return (
    <aside
      className={cn(
        "relative overflow-hidden",
        bare
          ? "border-0 bg-transparent"
          : "border-y border-border/60 bg-background/60 backdrop-blur-sm",
        isCompact ? "my-0" : "mt-8",
        className
      )}
      aria-label="Legal disclaimer"
    >
      {!bare && <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-primary/40 to-transparent" />}

      <div className={cn(
        "mx-auto",
        bare ? "max-w-none px-0 py-0" : "max-w-4xl px-6 py-8 sm:py-10"
      )}>
        <div className={cn("mb-5 flex items-center gap-2.5", isCompact && "mb-3")}>
          <div className="grid h-7 w-7 place-items-center rounded border border-primary/30 bg-primary/10 text-primary/90">
            <Scale size={14} strokeWidth={1.75} />
          </div>
          <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            HYBRID ENGINE 1.0 & PLATFORM LEGAL NOTICE
          </h3>
        </div>


        <div className="space-y-5 text-[13px] leading-6 text-muted-foreground/90">
          <section>
            <h4 className="mb-1.5 flex items-center gap-2 font-semibold text-foreground/80">
              <ShieldAlert size={14} strokeWidth={1.75} className="text-primary/70" />
              1. Technology Provider Status & Tool Usage
            </h4>
            <p className="text-muted-foreground/80">
              Hybrid AI Records LLC operates strictly as an infrastructure, audio synthesis, and digital distribution service provider. All audio, lyrical arrangements, vocal synthesis outputs, and visual media created within the Hybrid Engine 1.0 Alpha are generated directly via user input, text prompting, and custom asset uploads. The end user retains sole responsibility for the intent, context, and utilization of all generated outputs.
            </p>
          </section>

          {/* CSS-only accordion using a checkbox peer.
              Mobile: collapsed by default; label toggles the hidden checkbox.
              Desktop: content is always visible and toggle labels are hidden. */}
          <div className="disclaimer-accordion">
            <input
              id={toggleId}
              type="checkbox"
              className="peer hidden"
              aria-hidden="true"
            />

            <div className="hidden space-y-5 pt-2 peer-checked:block sm:block">
              <section>
                <h4 className="mb-1.5 flex items-center gap-2 font-semibold text-foreground/80">
                  <Copyright size={14} strokeWidth={1.75} className="text-primary/70" />
                  2. Intellectual Property, Voice Likeness & Provenance Warranties
                </h4>
                <p className="mb-2 text-muted-foreground/80">
                  By utilizing the Hybrid Engine 1.0 Alpha, users expressly warrant and represent that:
                </p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground/80 marker:text-primary/60">
                  <li>
                    They hold all necessary rights, licenses, and authorizations for any custom audio, reference vocals, lyrics, or samples uploaded into the engine.
                  </li>
                  <li>
                    Input prompts and uploaded media do not infringe upon any third-party copyrights, registered trademarks, patents, proprietary trade secrets, or right-of-publicity/voice likeness laws.
                  </li>
                  <li>
                    The creation does not unlawfully replicate, clone, impersonate, or simulate the distinctive voice, identity, or signature performance of any established recording artist, public figure, or protected entity without verified written permission.
                  </li>
                </ul>
              </section>

              {!isCompact && (
                <>
                  <section>
                    <h4 className="mb-1.5 flex items-center gap-2 font-semibold text-foreground/80">
                      <FileWarning size={14} strokeWidth={1.75} className="text-primary/70" />
                      3. Distribution, Quality Control & Content Moderation
                    </h4>
                    <p className="text-muted-foreground/80">
                      Hybrid AI Records LLC and its authorized enterprise delivery partners reserve the absolute right to reject, halt, or revoke distribution to digital storefronts (DSPs) if any submitted audio, metadata, or artwork fails Quality Control (QC) standards, triggers copyright identification flags (including YouTube Content ID and Meta Rights Manager), or violates DSP anti-impersonation rules. Distribution submission fees cover technical processing, review, and routing; they do not guarantee permanent DSP placement or playlist inclusion.
                    </p>
                  </section>

                  <section>
                    <h4 className="mb-1.5 flex items-center gap-2 font-semibold text-foreground/80">
                      <Scale size={14} strokeWidth={1.75} className="text-primary/70" />
                      4. Comprehensive Indemnification & Limitation of Liability
                    </h4>
                    <p className="text-muted-foreground/80">
                      Under no circumstances shall Hybrid AI Records LLC, its executive officers, partners, affiliates, or technical operators be liable for any direct, indirect, incidental, punitive, or consequential damages resulting from user-generated content, copyright disputes, statutory takedown notices, or platform bans. The user agrees to fully defend, indemnify, and hold harmless Hybrid AI Records LLC against any legal claims, liabilities, damages, costs, and legal fees arising from the user's content, distribution requests, or breach of these terms.
                    </p>
                  </section>

                  <section>
                    <h4 className="mb-1.5 flex items-center gap-2 font-semibold text-foreground/80">
                      <FileWarning size={14} strokeWidth={1.75} className="text-primary/70" />
                      5. DMCA & Rights Enforcement
                    </h4>
                    <p className="text-muted-foreground/80">
                      Hybrid AI Records LLC complies strictly with applicable digital copyright laws and takedown procedures. Any release found to infringe upon legitimate third-party intellectual property will be removed from all servers and distribution endpoints immediately upon formal notice.
                    </p>
                  </section>
                </>
              )}

              {isCompact && (
                <p className="text-[12px] leading-5 text-muted-foreground/70">
                  By using Hybrid Engine 1.0 Alpha you warrant that you own all rights to uploaded material, that your outputs do not infringe third-party copyrights or voice-likeness rights, and that you agree to indemnify Hybrid AI Records LLC against any claims arising from your content. Distribution fees do not guarantee permanent placement. Full terms apply.
                </p>
              )}
            </div>

            <label
              htmlFor={toggleId}
              className="peer-checked:hidden sm:hidden mt-4 flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-border/60 bg-background/80 px-4 py-2.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Read full disclaimer"
            >
              Read full disclaimer
              <ChevronDown size={14} className="transition-transform duration-200" />
            </label>

            <label
              htmlFor={toggleId}
              className="hidden peer-checked:flex sm:hidden mt-4 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-border/60 bg-background/80 px-4 py-2.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Show less disclaimer"
            >
              Show less
              <ChevronUp size={14} className="transition-transform duration-200" />
            </label>
          </div>
        </div>

        {!bare && (
          <div className="mt-6 border-t border-border/40 pt-4 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
            © Hybrid AI Records LLC. All Rights Reserved.
          </div>
        )}
      </div>
    </aside>
  );
}
