import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ClipboardCheck, Pencil } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { z } from "zod";
import { sendApplicationEmail } from "@/lib/application-email.functions";
import { createTrackRequest } from "@/lib/track-requests.functions";
import { OrderWhatsAppAction } from "@/components/OrderWhatsAppAction";
import { CopyOrderLinkButton } from "@/components/CopyOrderLinkButton";
import { BulkQrExport } from "@/components/BulkQrExport";
import { useCurrency } from "@/lib/currency";
import { LANGUAGES, useLanguageState } from "@/lib/i18n";
import { useActiveDivision, useDivisionNames } from "@/lib/division-settings";
import {
  ORDER_PACKAGES,
  packageFromSearch,
  sanitizeOrderPackageParam,
  prefillFromSearch,
  syncOrderUrl,
  pushOrderUrl,
  readOrderHistoryState,
  saveOrderPrefill,
  loadOrderPrefill,
  clearOrderPrefill,
  type OrderPackage,
} from "@/lib/order-link";

const PACKAGES = ORDER_PACKAGES;

type PackageOption = OrderPackage;


type FieldName = "artist" | "email" | "link" | "pkg";
type Errors = Partial<Record<FieldName, string>>;

const orderSchema = z.object({
  artist: z
    .string()
    .trim()
    .min(1, { message: "Enter your artist or stage name." })
    .max(200, { message: "Keep your artist name under 200 characters." }),
  email: z
    .string()
    .trim()
    .min(1, { message: "Enter your email address." })
    .email({ message: "Enter a valid email address (name@example.com)." })
    .max(255, { message: "Email must be under 255 characters." }),
  pkg: z.enum(PACKAGES, { message: "Choose a package." }),
  link: z
    .string()
    .trim()
    .min(1, { message: "Paste a link to your vocal audio or demo." })
    .max(600, { message: "Link must be under 600 characters." })
    .regex(/^https?:\/\/\S+\.\S+/i, {
      message: "Use a full link starting with https:// (Drive, Dropbox, WeTransfer).",
    }),
});

const FIELD_ORDER: FieldName[] = ["artist", "email", "pkg", "link"];
const INPUT_ID: Record<FieldName, string> = {
  artist: "qo-artist",
  email: "qo-email",
  pkg: "qo-package",
  link: "qo-link",
};

export function QuickOrderForm() {
  const [artist, setArtist] = useState("");
  const [email, setEmail] = useState("");
  const [pkg, setPkg] = useState<PackageOption>("Distribution & Release");
  const [link, setLink] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  /** "form" collects details, "review" confirms them before anything is sent. */
  const [step, setStep] = useState<"form" | "review">("form");

  // Live site settings shown in the confirmation summary.
  const currency = useCurrency();
  const { language } = useLanguageState();
  const activeDivision = useActiveDivision();
  const divisionNames = useDivisionNames();
  const languageLabel = LANGUAGES.find((l) => l.code === language)?.label ?? "English";
  const divisionLabel = divisionNames[activeDivision];

  // Prefill from a shared /portal?package=<slug>&artist=…&email=…&demo=…#order link,
  // falling back to this device's last saved entry. Also keeps up with
  // back/forward navigation. SSR-safe: reads on mount.
  const hydrated = useRef(false);
  /** Tier the mount-time prefill asked for, until React commits it. */
  const pendingPkg = useRef<OrderPackage | null>(null);
  useEffect(() => {
    const apply = (allowStorage: boolean) => {
      // Fix up ?package= first: canonicalize aliases, drop junk. Hash untouched.
      const shared = sanitizeOrderPackageParam() ?? packageFromSearch(window.location.search);
      const fromUrl = prefillFromSearch(window.location.search);

      const stored = allowStorage ? loadOrderPrefill() : null;
      const historyState = readOrderHistoryState(window.history.state);

      // History state wins on back/forward: it records the tier for that entry.
      const nextPkg = historyState?.pkg ?? shared ?? (allowStorage ? stored?.pkg : null);
      if (nextPkg) {
        pendingPkg.current = nextPkg;
        setPkg(nextPkg);
      }
      const nextArtist = fromUrl.artist || stored?.artist || "";
      const nextEmail = fromUrl.email || stored?.email || "";
      const nextLink = fromUrl.link || stored?.link || "";
      if (nextArtist) setArtist(nextArtist);
      if (nextEmail) setEmail(nextEmail);
      if (nextLink) setLink(nextLink);
      return historyState?.focusId ?? null;
    };
    apply(true);
    const onPop = () => {
      const focusId = apply(false);
      // Only restore in-form focus while still on the order deep link —
      // leaving #order is owned by OrderIntakeSection (Escape → CTA).
      // Re-check hash after paint so a same-tick Escape/back dismiss wins.
      if (!focusId || window.location.hash !== "#order") return;
      requestAnimationFrame(() => {
        if (window.location.hash !== "#order") return;
        const el = document.getElementById(focusId) as HTMLElement | null;
        el?.focus({ preventScroll: false });
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);


  // Persist entries + keep the address bar shareable as details change.
  useEffect(() => {
    if (sent) return;
    if (!hydrated.current) {
      // Wait for the mount-time prefill to commit, otherwise the first pass
      // would rewrite a shared /?package=<slug> link back to the default tier.
      if (pendingPkg.current && pkg !== pendingPkg.current) return;
      hydrated.current = true;
    }
    const id = setTimeout(() => {
      const details = { artist, email, link };
      syncOrderUrl(pkg, details);
      saveOrderPrefill(pkg, details);
    }, 400);
    return () => clearTimeout(id);
  }, [artist, email, link, pkg, sent]);



  // Only nag about a field once it has been submitted or left ("blurred").
  const touched = useRef<Set<FieldName>>(new Set());


  function collectErrors(values = { artist, email, pkg, link }): Errors {
    const result = orderSchema.safeParse(values);
    if (result.success) return {};
    const next: Errors = {};
    for (const issue of result.error.issues) {
      const key = issue.path[0] as FieldName | undefined;
      if (key && !next[key]) next[key] = issue.message;
    }
    return next;
  }

  /** Re-check a single field after it is touched, so errors clear as you type. */
  function revalidate(field: FieldName, overrides: Partial<Record<FieldName, string>> = {}) {
    if (!touched.current.has(field)) return;
    const all = collectErrors({ artist, email, pkg, link, ...overrides } as typeof orderSchema._input);
    setErrors((prev) => ({ ...prev, [field]: all[field] }));
  }

  function markTouched(field: FieldName) {
    touched.current.add(field);
    revalidate(field);
  }

  /** Validates and moves to the confirmation step — nothing is sent yet. */
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = collectErrors();
    FIELD_ORDER.forEach((f) => touched.current.add(f));
    setErrors(next);

    const missing = FIELD_ORDER.filter((f) => next[f]);
    if (missing.length > 0) {
      // Move the user (and screen readers) straight to the first problem.
      const first = missing[0]!;
      document.getElementById(INPUT_ID[first])?.focus();
      toast.error(
        missing.length === 1
          ? "One field needs your attention before submitting."
          : `${missing.length} fields need your attention before submitting.`,
      );
      return;
    }

    setStep("review");
  }

  /** Final send, only reachable from the confirmation step. */
  async function confirmSubmit() {
    setBusy(true);
    try {
      // Save the submission first — the database record is what the admin
      // dashboard and /order-status read. Email is a courtesy on top.
      const saved = await createTrackRequest({
        data: {
          artist: artist.trim(),
          email: email.trim(),
          packageLabel: pkg,
          link: link.trim() || undefined,
          acknowledged: true,
        },
      });

      if (!saved.ok || !saved.reference) {
        toast.error("Could not submit right now. Please try again in a moment.");
        return;
      }

      setReference(saved.reference);
      setSent(true);

      // Non-fatal: a failed notification must not lose a saved submission.
      try {
        await sendApplicationEmail({
          data: {
            artist: artist.trim(),
            email: email.trim(),
            packageLabel: pkg,
            link: link.trim(),
            acknowledged: true,
          },
        });
      } catch {
        // Swallowed on purpose — the request is already recorded.
      }
    } catch {
      toast.error("Could not submit right now. Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  function resetForm() {
    setSent(false);
    setReference(null);
    setStep("form");
    setArtist("");
    setEmail("");
    setLink("");
    setErrors({});
    touched.current.clear();
    // Drop the saved details and strip them from the address bar.
    clearOrderPrefill();
    syncOrderUrl(pkg, {});
  }



  const summaryRows: { label: string; value: string }[] = [
    { label: "Artist", value: artist.trim() },
    { label: "Email", value: email.trim() },
    { label: "Package", value: pkg },
    { label: "Currency", value: currency },
    { label: "Language", value: languageLabel },
    { label: "Division", value: divisionLabel },
    { label: "Demo link", value: link.trim() },
  ];

  const SummaryList = () => (
    <dl className="divide-y divide-border border border-border bg-background/50 text-start">
      {summaryRows.map((row) => (
        <div key={row.label} className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3">
          <dt className="min-w-28 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            {row.label}
          </dt>
          <dd className="min-w-0 flex-1 break-words text-sm text-white">{row.value}</dd>
        </div>
      ))}
    </dl>
  );

  if (sent) {
    return (
      <div
        id="quick-order-form"
        role="status"
        aria-live="polite"
        className="scroll-mt-24 border border-primary/50 bg-background/40 p-6 text-center backdrop-blur-sm sm:p-8"
      >
        <CheckCircle2 className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
        <h3 className="mt-4 font-display text-2xl font-semibold text-white">Track Submitted</h3>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/80">
          Thanks, {artist.trim()} — we received your <span className="text-white">{pkg}</span>{" "}
          submission. Our team reviews your audio and sends your first draft preview within{" "}
          <span className="font-semibold text-white">5–7 business days</span>. Watch{" "}
          <span className="text-white">{email.trim()}</span> for the confirmation and next steps.
        </p>

        {reference ? (
          <p className="mx-auto mt-4 max-w-md font-mono text-xs uppercase tracking-[0.2em] text-white/80">
            Reference <span className="text-primary">{reference}</span>
          </p>
        ) : null}



        <div className="mt-6">
          <SummaryList />
        </div>

        <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
          Next step
        </p>
        <Link
          to="/order-status"
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#e11d2e] bg-[#e11d2e] px-6 py-3 text-xs font-semibold uppercase tracking-widest text-black transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Track your order status
        </Link>
        <div className="mt-3">
          <OrderWhatsAppAction details={{ artist, email, packageLabel: pkg, link }} />
        </div>
        <div className="mt-3">
          <CopyOrderLinkButton pkg={pkg} details={{ artist, email, link }} />
        </div>
        <button
          type="button"
          onClick={resetForm}
          className="mt-3 min-h-11 w-full border border-white px-8 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
        >
          Submit another track
        </button>
      </div>
    );
  }

  if (step === "review") {
    return (
      <section
        id="quick-order-form"
        aria-labelledby="qo-review-title"
        className="scroll-mt-24 border border-border bg-background/40 p-6 backdrop-blur-sm sm:p-8"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
          Step 2 of 2 — Confirm
        </p>
        <h3
          id="qo-review-title"
          className="mt-2 flex items-center gap-2 font-display text-2xl font-semibold text-white"
        >
          <ClipboardCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          Review your order
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-white/80">
          Check the details below. Nothing has been submitted yet.
        </p>

        <div className="mt-5">
          <SummaryList />
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={confirmSubmit}
            disabled={busy}
            className="btn-primary min-h-11 flex-1 disabled:opacity-60"
          >
            {busy ? "Submitting…" : "Confirm & Submit"}
          </button>
          <button
            type="button"
            onClick={() => setStep("form")}
            disabled={busy}
            className="inline-flex min-h-11 items-center justify-center gap-2 border border-border-strong px-5 py-3 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white/10 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
          >
            <Pencil size={14} aria-hidden="true" />
            Edit details
          </button>
        </div>
      </section>
    );
  }



  const field =
    "mt-2 w-full border border-border bg-background/50 px-4 py-3 text-sm text-white outline-none transition-colors focus:border-primary";
  const fieldState = (invalid: boolean) =>
    invalid ? `${field} border-primary focus:border-primary` : field;
  const labelCls = "font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground";
  // Lightened crimson: the brand tone only clears ~4.2:1 on near-black.
  const errorCls = "mt-2 text-xs text-status-accent";
  const errorCount = FIELD_ORDER.filter((f) => errors[f]).length;

  const Required = () => (
    <span className="ms-1 text-primary" aria-hidden="true">
      *
    </span>
  );

  return (
    <form
      id="quick-order-form"
      onSubmit={onSubmit}
      noValidate
      aria-describedby="qo-required-note"
      className="scroll-mt-24 space-y-5 border border-border bg-background/40 p-6 backdrop-blur-sm sm:p-8"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
        Step 1 of 2 — Your details
      </p>
      <p id="qo-required-note" className="text-xs text-muted-foreground">
        All fields marked <span className="text-primary">*</span> are required.
      </p>

      {/* Announces the outcome of a blocked submit to screen readers. */}
      <p role="status" aria-live="polite" className="sr-only">
        {errorCount > 0
          ? `${errorCount} field${errorCount === 1 ? "" : "s"} need attention before this form can be submitted.`
          : ""}
      </p>

      <div>
        <label htmlFor="qo-artist" className={labelCls}>
          Artist / Stage Name
          <Required />
        </label>
        <input
          id="qo-artist"
          name="artist"
          required
          value={artist}
          maxLength={200}
          autoComplete="nickname"
          onChange={(e) => {
            setArtist(e.target.value);
            revalidate("artist", { artist: e.target.value });
          }}
          onBlur={() => markTouched("artist")}
          aria-required="true"
          aria-invalid={!!errors.artist}
          aria-describedby={errors.artist ? "qo-artist-error" : undefined}
          className={fieldState(!!errors.artist)}
        />
        {errors.artist && (
          <p id="qo-artist-error" role="alert" className={errorCls}>
            {errors.artist}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="qo-email" className={labelCls}>
          Email Address
          <Required />
        </label>
        <input
          id="qo-email"
          type="email"
          required
          value={email}
          maxLength={255}
          autoComplete="email"
          onChange={(e) => {
            setEmail(e.target.value);
            revalidate("email", { email: e.target.value });
          }}
          onBlur={() => markTouched("email")}
          aria-required="true"
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? "qo-email-error" : undefined}
          className={fieldState(!!errors.email)}
        />
        {errors.email && (
          <p id="qo-email-error" role="alert" className={errorCls}>
            {errors.email}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="qo-package" className={labelCls}>
          Package Selection
          <Required />
        </label>
        <select
          id="qo-package"
          required
          value={pkg}
          onChange={(e) => {
            const value = e.target.value as PackageOption;
            const details = { artist, email, link };
            // Stamp the entry we're leaving with its tier + focus, then push a
            // new entry so Back/Forward restores both.
            syncOrderUrl(pkg, details, "qo-package");
            setPkg(value);
            pushOrderUrl(value, details, "qo-package");
            touched.current.add("pkg");
            revalidate("pkg", { pkg: value });
          }}

          onBlur={() => markTouched("pkg")}
          aria-required="true"
          aria-invalid={!!errors.pkg}
          aria-describedby={errors.pkg ? "qo-package-error" : undefined}
          className={fieldState(!!errors.pkg)}
        >
          {PACKAGES.map((p) => (
            <option key={p} value={p} className="bg-background text-white">
              {p}
            </option>
          ))}
        </select>
        {errors.pkg && (
          <p id="qo-package-error" role="alert" className={errorCls}>
            {errors.pkg}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="qo-link" className={labelCls}>
          Link to Vocal Audio / Demo
          <Required />
        </label>
        <input
          id="qo-link"
          type="url"
          inputMode="url"
          required
          value={link}
          maxLength={600}
          placeholder="Paste Google Drive, Dropbox, or WeTransfer link"
          onChange={(e) => {
            setLink(e.target.value);
            revalidate("link", { link: e.target.value });
          }}
          onBlur={() => markTouched("link")}
          aria-required="true"
          aria-invalid={!!errors.link}
          aria-describedby={errors.link ? "qo-link-error" : undefined}
          className={`${fieldState(!!errors.link)} placeholder:text-muted-foreground`}
        />
        {errors.link && (
          <p id="qo-link-error" role="alert" className={errorCls}>
            {errors.link}
          </p>
        )}
      </div>

      <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-60">
        Review Your Order
      </button>
      <OrderWhatsAppAction details={{ artist, email, packageLabel: pkg, link }} />
      <CopyOrderLinkButton pkg={pkg} details={{ artist, email, link }} />
      <BulkQrExport />
      <p className="text-center text-xs text-muted-foreground">
        First draft preview delivered in 5–7 business days. You keep 100% of your masters.
      </p>
    </form>
  );
}
