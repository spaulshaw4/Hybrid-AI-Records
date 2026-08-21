import { useState } from "react";
import { MessageCircle, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CONTACTS } from "@/components/ContactModal";

/** Founder desk handles order questions; phone contact is WhatsApp-only. */
const SUPPORT_WHATSAPP = CONTACTS[0]!.whatsappUrl;

const MAX_MESSAGE = 900;

export type OrderWhatsAppDetails = {
  artist: string;
  email: string;
  packageLabel: string;
  link: string;
};

/** Builds the prefilled order message from whatever the artist has typed so far. */
export function orderWhatsAppMessage(d: OrderWhatsAppDetails): string {
  const lines = [
    `Hi Hybrid AI Records — I'd like to order the ${d.packageLabel} package.`,
  ];
  if (d.artist.trim()) lines.push(`Artist / stage name: ${d.artist.trim()}`);
  if (d.email.trim()) lines.push(`Email: ${d.email.trim()}`);
  if (d.link.trim()) lines.push(`Vocal audio / demo: ${d.link.trim()}`);
  lines.push("Can you confirm next steps and turnaround?");
  return lines.join("\n").slice(0, MAX_MESSAGE);
}

/**
 * Secondary action on the order form: shows an editable preview of the
 * prefilled message and only opens WhatsApp after the artist confirms.
 */
export function OrderWhatsAppAction({ details }: { details: OrderWhatsAppDetails }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const preset = orderWhatsAppMessage(details);

  function openPreview() {
    setDraft(preset);
    setOpen(true);
  }

  function send() {
    const text = draft.trim().slice(0, MAX_MESSAGE);
    if (!text) {
      toast.error("Write a message before sending it to WhatsApp.");
      return;
    }
    const href = `${SUPPORT_WHATSAPP}?text=${encodeURIComponent(text)}`;
    window.open(href, "_blank", "noopener,noreferrer");
    setOpen(false);
    toast.success("Opening WhatsApp with your message");
  }

  return (
    <>
      <button
        type="button"
        onClick={openPreview}
        className="inline-flex min-h-11 w-full items-center justify-center gap-2 border border-border-strong bg-background/40 px-5 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
      >
        <MessageCircle size={16} aria-hidden="true" />
        Send this on WhatsApp
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          id="order-whatsapp-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="order-whatsapp-title"
          aria-describedby="order-whatsapp-description"
          className="sm:max-w-lg border-border-strong bg-background/95 backdrop-blur-md sm:rounded-none"
        >
          <DialogHeader>
            <DialogTitle
              id="order-whatsapp-title"
              className="font-display text-xl font-semibold text-white"
            >
              Review your WhatsApp message
            </DialogTitle>
            <DialogDescription
              id="order-whatsapp-description"
              className="text-sm text-muted-foreground"
            >
              Prefilled with the <span className="text-white/85">{details.packageLabel}</span>{" "}
              package. Edit anything you want, then confirm to open WhatsApp.
            </DialogDescription>
          </DialogHeader>

          <label htmlFor="order-whatsapp-text" className="sr-only">
            WhatsApp message
          </label>
          <textarea
            id="order-whatsapp-text"
            rows={7}
            value={draft}
            maxLength={MAX_MESSAGE}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full resize-y border border-border bg-background/50 px-4 py-3 text-sm leading-relaxed text-white outline-none transition-colors focus:border-primary"
          />
          <p className="text-xs text-muted-foreground">
            {draft.length}/{MAX_MESSAGE} characters
          </p>

          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={send}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 border border-[#e11d2e] bg-[#e11d2e] px-5 py-3 text-xs font-semibold uppercase tracking-widest text-black transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <MessageCircle size={16} aria-hidden="true" />
              Confirm & open WhatsApp
            </button>
            <button
              type="button"
              onClick={() => setDraft(preset)}
              disabled={draft === preset}
              className="inline-flex min-h-11 items-center justify-center gap-2 border border-border-strong px-4 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white/10 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              <RotateCcw size={14} aria-hidden="true" />
              Reset
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex min-h-11 items-center justify-center border border-border px-4 py-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
            >
              Cancel
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
