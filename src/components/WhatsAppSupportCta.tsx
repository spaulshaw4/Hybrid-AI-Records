import { MessageCircle } from "lucide-react";
import { SERVICES } from "@/lib/services";
import { CONTACTS } from "@/components/ContactModal";
import { supportMessage, useSupportRequest } from "@/lib/support-request";

/** Founder desk handles pricing and revision questions; phone contact is WhatsApp-only. */
const SUPPORT_WHATSAPP = CONTACTS[0]!.whatsappUrl;

/**
 * The one WhatsApp entry point for the Services panel. It always reflects the
 * artist's current tier and revision inputs, so no section needs its own prompt.
 */
export function WhatsAppSupportCta() {
  const req = useSupportRequest();
  const pkg = req.tierSlug ? SERVICES.find((s) => s.slug === req.tierSlug) : undefined;
  const message = supportMessage(req);
  const href = `${SUPPORT_WHATSAPP}?text=${encodeURIComponent(message)}`;

  const summary = [
    pkg?.title ?? null,
    req.round ? `round ${req.round}` : null,
    req.notes.trim() ? "your notes" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border border-border bg-background/40 p-5 backdrop-blur-sm">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center gap-2 border border-[#e11d2e] bg-[#e11d2e] px-5 py-3 text-sm font-semibold uppercase tracking-widest text-black transition-all hover:opacity-90 hover:shadow-[0_0_28px_-4px_rgba(225,29,46,0.85)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <MessageCircle size={16} aria-hidden />
        Ask us on WhatsApp
      </a>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {summary ? (
          <>
            Prefilled with <span className="font-medium text-white/85">{summary}</span>.
          </>
        ) : (
          "No package preselected — tell us what you need."
        )}
      </p>
    </div>
  );
}
