import { useEffect } from "react";
import { DEFAULT_DIVISION_NAMES, useDivisionNames } from "@/lib/division-settings";
import { X, MessageCircle, Mail, Phone } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Contact = {
  num: string;
  division: string;
  divisionColor: string;
  name: string;
  role: string;
  phoneDisplay: string;
  whatsappUrl: string;
  email: string;
};

export const CONTACTS: Contact[] = [
  {
    num: "01",
    division: "Executive Leadership",
    divisionColor: "text-[#e11d2e]",
    name: "Stephen P. Shaw",
    role: "Founder & CEO",
    phoneDisplay: "+1 618-479-3630",
    whatsappUrl: "https://wa.me/16184793630",
    email: "Spaulshaw04@gmail.com",
  },
  {
    num: "02",
    division: "Executive Operations",
    divisionColor: "text-white",
    name: "Jesse Minor",
    role: "Vice President",
    phoneDisplay: "+1 618-513-8005",
    whatsappUrl: "https://wa.me/16185138005",
    email: "minorjesse83@gmail.com",
  },
  {
    num: "03",
    division: "International Division",
    divisionColor: "text-[#4b8bff]",
    name: "Sage Zimba",
    role: "Head of Nigeria Division",
    phoneDisplay: "+265 992 20 56 36",
    whatsappUrl: "https://wa.me/265992205636",
    email: "sangulusoz@gmail.com",
  },
  {
    num: "04",
    division: "Midwest & {jester}",
    divisionColor: "text-[#e11d2e]",
    name: "Jesse Thomas",
    role: "Head of the Midwest Division & Head of {jester}",
    phoneDisplay: "+1 618-335-6454",
    whatsappUrl: "https://wa.me/16183356454",
    email: "jessethomas1122123@gmail.com",
  },
];

/** Builds a click-to-call `tel:` href (E.164) from a display phone number. */
export function telHref(phoneDisplay: string): string {
  return `tel:+${phoneDisplay.replace(/\D/g, "")}`;
}

/** Fills the {jester} placeholder with the current division name. */
export function resolveContacts(names: { jester: string } = DEFAULT_DIVISION_NAMES): Contact[] {
  return CONTACTS.map((c) => ({
    ...c,
    division: c.division.replaceAll("{jester}", names.jester),
    role: c.role.replaceAll("{jester}", names.jester),
  }));
}




export function ContactModal({ open, onClose }: Props) {
  const contacts = resolveContacts(useDivisionNames());
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
      aria-label="Contact Our Team"
      className="fixed inset-0 z-[100] flex h-[100dvh] flex-col modal-panel-solid ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)] lg:ps-[var(--site-sidebar-width)]"
    >
      <div className="flex items-center justify-between border-b border-border px-6 pb-4 pt-[calc(1rem+env(safe-area-inset-top))] sm:px-10">
        <div className="min-w-0 pe-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            <span className="text-[#e11d2e]">Contact</span>{" "}
            <span className="text-white">Our</span>{" "}
            <span className="text-[#4b8bff]">Team</span>
          </div>
          <div className="mt-1 truncate font-display text-sm font-semibold sm:text-base">
            Hybrid AI Records LLC
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close contact"
          className="grid h-10 w-10 shrink-0 place-items-center border border-border text-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-6 pt-10 pb-[calc(2.5rem+env(safe-area-inset-bottom))] sm:px-10 sm:pt-14">
        <header className="border-b border-border pb-10">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            <span className="text-[#e11d2e]">HYBRID</span>{" "}
            <span className="text-white">AI</span>{" "}
            <span className="text-[#4b8bff]">RECORDS LLC</span>
          </div>
          <h2 className="mt-4 font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl md:text-5xl">
            Contact Our Team
          </h2>
          <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-muted-foreground sm:text-base sm:leading-[1.75]">
            Reach the right desk directly. All phone communications are managed
            exclusively via WhatsApp — tap the button on any card to start a chat.
          </p>
        </header>

        <div className="grid gap-6 pt-10 md:grid-cols-2 xl:grid-cols-3">
          {contacts.map((c) => (
            <article
              key={c.num}
              className="flex flex-col border border-border bg-background/40 p-6 backdrop-blur-sm transition-colors hover:border-primary/60 sm:p-8"
            >
              <div className={`font-mono text-[10px] uppercase tracking-[0.24em] ${c.divisionColor}`}>
                / {c.num} · {c.division}
              </div>
              <h2 className="mt-4 font-display text-xl font-semibold leading-tight tracking-tight text-white sm:text-2xl">
                {c.name}
              </h2>
              <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
                {c.role}
              </div>

              <div className="mt-6 space-y-4 text-sm">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                    Phone / WhatsApp
                  </div>
                  <a
                    href={telHref(c.phoneDisplay)}
                    aria-label={`Call ${c.name} at ${c.phoneDisplay}`}
                    className="mt-1 inline-flex items-center gap-2 font-mono text-white transition-colors hover:text-primary"
                  >
                    <Phone size={14} className="shrink-0" />
                    <span>{c.phoneDisplay}</span>
                  </a>
                </div>

                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                    Email
                  </div>
                  <a
                    href={`mailto:${c.email}`}
                    className="mt-1 inline-flex items-center gap-2 break-all text-white transition-colors hover:text-primary"
                  >
                    <Mail size={14} className="shrink-0" />
                    <span>{c.email}</span>
                  </a>
                </div>
              </div>

              <div className="mt-auto flex flex-col gap-3 pt-8">
                <a
                  href={c.whatsappUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center gap-2 border border-[#25D366] bg-[#25D366] px-4 py-3 text-xs font-semibold uppercase tracking-widest text-black transition-colors hover:bg-transparent hover:text-[#25D366]"
                >
                  <MessageCircle size={14} />
                  Chat on WhatsApp
                </a>
                <a
                  href={telHref(c.phoneDisplay)}
                  aria-label={`Call ${c.name} at ${c.phoneDisplay}`}
                  className="inline-flex items-center justify-center gap-2 border border-[#e11d2e] px-4 py-3 text-xs font-semibold uppercase tracking-widest text-[#e11d2e] transition-colors hover:bg-[#e11d2e] hover:text-black"
                >
                  <Phone size={14} />
                  Call {c.phoneDisplay}
                </a>

                <a
                  href={`mailto:${c.email}`}
                  className="inline-flex items-center justify-center gap-2 border border-white px-4 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-black"
                >
                  <Mail size={14} />
                  Send Email
                </a>
              </div>
            </article>
          ))}
        </div>

        <section className="mt-12 border border-border bg-background/40 p-6 backdrop-blur-sm sm:p-8">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#e11d2e]">
            / Label Inquiries
          </div>
          <h2 className="mt-3 font-display text-xl font-semibold leading-tight tracking-tight text-white sm:text-2xl">
            General Business & Invoicing
          </h2>
          <div className="mt-4 space-y-2 text-[15px] text-muted-foreground sm:leading-[1.75]">
            <div>
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                Email:
              </span>{" "}
              <a
                href="mailto:Hybrid.AI.Records@proton.me"
                className="text-white transition-colors hover:text-primary"
              >
                Hybrid.AI.Records@proton.me
              </a>
            </div>
            <p className="pt-2 text-sm">
              <span className="text-[#e11d2e]">Note:</span> All phone communications are managed
              exclusively via WhatsApp.
            </p>
          </div>
        </section>

        <div className="mt-12 flex justify-center">
          <button
            type="button"
            onClick={onClose}
            className="border border-white px-10 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-black"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
