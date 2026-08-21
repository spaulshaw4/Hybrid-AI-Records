import { useEffect, useRef, useState } from "react";
import { CheckCircle2, MessageSquare, Phone, X } from "lucide-react";
import { toast } from "sonner";
import { sendSupportMessage } from "@/lib/support-chat.functions";
import { resolveContacts, telHref } from "@/components/ContactModal";
import { useDivisionNames } from "@/lib/division-settings";

const TOPICS = [
  "Vocal Submission",
  "Package Question",
  "Label Distribution",
  "General Inquiry",
] as const;

type Topic = (typeof TOPICS)[number];

export function LiveChatWidget() {
  const contacts = resolveContacts(useDivisionNames());
  const [open, setOpen] = useState(false);

  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [artist, setArtist] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState<Topic>("Vocal Submission");
  const [message, setMessage] = useState("");
  // Keeps the widget from sitting on top of the radio console / audio controls.
  const [radioVisible, setRadioVisible] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const radio = document.getElementById("radio");
    if (!radio) return;
    const io = new IntersectionObserver(
      (entries) => setRadioVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: "0px 0px -40% 0px", threshold: 0 },
    );
    io.observe(radio);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent | TouchEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // Passive: this only closes the panel, it never calls preventDefault, so
    // iOS Safari can keep scrolling on the compositor thread.
    const opts: AddEventListenerOptions = { passive: true };
    document.addEventListener("mousedown", onDown, opts);
    document.addEventListener("touchstart", onDown, opts);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);

    };
  }, [open]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await sendSupportMessage({
        data: { artist: artist.trim(), email: email.trim(), topic, message: message.trim() },
      });
      setSent(true);
      setArtist("");
      setEmail("");
      setMessage("");
    } catch {
      toast.error("Could not send your message. Please try again or email us directly.");
    } finally {
      setBusy(false);
    }
  }

  if (radioVisible && !open) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-40 flex max-w-[calc(100vw-3rem)] flex-col items-end gap-3">
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Artist Support Chat"
          className="pointer-events-auto w-[min(23rem,calc(100vw-3rem))] overflow-hidden border border-border bg-background/90 shadow-2xl backdrop-blur-md"
        >
          <div className="flex items-start justify-between gap-3 border-b border-border bg-background/60 p-4">
            <div>
              <h2 className="font-display text-base font-semibold text-white">
                Hybrid AI Records — Direct Support
              </h2>
              <p className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                SBA Veteran-Certified · 100% Master Ownership
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close support chat"
              className="shrink-0 p-1 text-muted-foreground transition-colors hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {sent ? (
            <div className="p-6 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
              <h3 className="mt-4 font-display text-lg font-semibold text-white">
                Message Received!
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-white/80">
                We operate with real deadlines—expect a response in your inbox shortly.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSent(false);
                  setOpen(false);
                }}
                className="btn-primary mt-5 w-full"
              >
                Close
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="max-h-[70dvh] space-y-3 overflow-y-auto p-4">
              <p className="text-xs leading-relaxed text-white/75">
                Welcome to Hybrid AI Records! Got questions about submitting your raw vocals,
                release timelines, or keeping 100% of your royalties? Drop us a message below and
                Stephen or the team will reply directly to your email.
              </p>

              <div>
                <label htmlFor="hc-artist" className="text-xs font-medium text-white">
                  Stage / Artist Name
                </label>
                <input
                  id="hc-artist"
                  required
                  maxLength={200}
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                  className="mt-1 w-full border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-primary"
                />
              </div>

              <div>
                <label htmlFor="hc-email" className="text-xs font-medium text-white">
                  Email Address
                </label>
                <input
                  id="hc-email"
                  type="email"
                  required
                  maxLength={255}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-primary"
                />
              </div>

              <div>
                <label htmlFor="hc-topic" className="text-xs font-medium text-white">
                  What can we help you with?
                </label>
                <select
                  id="hc-topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value as Topic)}
                  className="mt-1 w-full border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-primary"
                >
                  {TOPICS.map((t) => (
                    <option key={t} value={t} className="bg-background text-white">
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="hc-message" className="text-xs font-medium text-white">
                  Your Message
                </label>
                <textarea
                  id="hc-message"
                  required
                  rows={4}
                  maxLength={4000}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="mt-1 w-full resize-y border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-primary"
                />
              </div>

              <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-60">
                {busy ? "Sending…" : "Send Message"}
              </button>

              <div className="border-t border-border pt-3">
                <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/70">
                  <Phone className="h-3.5 w-3.5 text-primary" />
                  Prefer to talk? Contact a desk directly
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Tap a number to call, or message the desk on WhatsApp.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {contacts.map((c) => (
                    <li
                      key={c.num}
                      className="flex items-center gap-2 border border-border bg-background/60 px-3 py-2 text-xs text-white"
                    >
                      <a
                        href={c.whatsappUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 flex-1 transition-colors hover:text-primary"
                      >
                        <span className="block truncate font-medium">{c.name}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {c.role}
                        </span>
                      </a>
                      <a
                        href={telHref(c.phoneDisplay)}
                        aria-label={`Call ${c.name} at ${c.phoneDisplay}`}
                        className="inline-flex shrink-0 items-center gap-1.5 border border-primary/60 px-2 py-1 font-mono text-[11px] text-primary transition-colors hover:bg-primary hover:text-black"
                      >
                        <Phone className="h-3 w-3" aria-hidden />
                        {c.phoneDisplay}
                      </a>
                    </li>
                  ))}
                </ul>

              </div>
            </form>

          )}
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Chat with Hybrid AI"
        className="pointer-events-auto relative inline-flex items-center gap-2 border border-border bg-background/85 px-4 py-3 text-sm font-semibold text-white shadow-xl backdrop-blur-md transition-colors hover:border-primary hover:bg-background"
      >
        <MessageSquare className="h-4 w-4 text-primary" />
        <span className="hidden sm:inline">Chat with Hybrid AI</span>
        <span className="sm:hidden">Chat</span>
        {!open && !sent && (
          <span aria-hidden className="absolute -right-1 -top-1 flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/70" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-primary" />
          </span>
        )}
      </button>
    </div>
  );
}
