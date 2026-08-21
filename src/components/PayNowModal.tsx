import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { z } from "zod";
import { clearDraft, useAutosavedState } from "@/lib/form-autosave";
import { createTrackRequest } from "@/lib/track-requests.functions";
import { PriceBreakdown } from "@/components/PriceBreakdown";
import type { CurrencyCode } from "@/lib/pricing";
import { useApplePayAvailable, useGooglePayAvailable } from "@/lib/wallets";

export type PayNowOrder = {
  /** Reference code created for this submission. */
  reference: string;
  email: string;
};

type Props = {
  open: boolean;
  packageLabel: string;
  priceLabel: string;
  /** Price ID + currency drive the itemised breakdown shown before payment. */
  priceId?: string;
  currency?: CurrencyCode;
  /** Single track vs 10-track bundle — recorded on the order. */
  orderKind?: "single" | "bundle";
  /** Pre-collected details (e.g. the 10-track bundle plan) saved with the order. */
  notes?: string | null;
  /** Video packages must confirm the one-shoot / no-refund terms here. */
  requireTerms?: boolean;
  onClose: () => void;
  onSubmitted: (order: PayNowOrder) => void;
};



type FieldName = "artist" | "email";
type Errors = Partial<Record<FieldName, string>>;

/**
 * Checkout asks for the absolute minimum: who you are and where to reach you.
 * Track titles, links, notes and uploads are collected on the success screen
 * after payment, so nothing stands between the customer and buying.
 */
const paySchema = z.object({
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
});

const FIELD_ORDER: FieldName[] = ["artist", "email"];
const INPUT_ID: Record<FieldName, string> = {
  artist: "pn-artist",
  email: "pn-email",
};

export function PayNowModal({
  open,
  packageLabel,
  priceLabel,
  priceId,
  currency,
  orderKind = "single",
  notes = null,
  requireTerms = false,
  onClose,
  onSubmitted,
}: Props) {
  // Autosaved per package, so closing the modal or refreshing keeps the entry.
  const draftKey = `paynow.${packageLabel}`;
  const [artist, setArtist] = useAutosavedState(`${draftKey}.artist`, "");
  const [email, setEmail] = useAutosavedState(`${draftKey}.email`, "");
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  /** Wallets are only advertised on devices that can actually present them. */
  const applePay = useApplePayAvailable();
  const googlePay = useGooglePayAvailable();
  const hasWallet = applePay || googlePay;




  /** Only nag about a field once it has been left ("blurred") or submitted. */
  const touched = useRef<Set<FieldName>>(new Set());

  const values = { artist, email };

  function collectErrors(overrides: Partial<typeof values> = {}): Errors {
    const result = paySchema.safeParse({ ...values, ...overrides });
    if (result.success) return {};
    const next: Errors = {};
    for (const issue of result.error.issues) {
      const key = issue.path[0] as FieldName | undefined;
      if (key && !next[key]) next[key] = issue.message;
    }
    return next;
  }

  /** Instant re-check of one field, so errors appear and clear as you type. */
  function revalidate(field: FieldName, overrides: Partial<typeof values> = {}) {
    if (!touched.current.has(field)) return;
    const all = collectErrors(overrides);
    setErrors((prev) => ({ ...prev, [field]: all[field] }));
  }

  function markTouched(field: FieldName) {
    touched.current.add(field);
    revalidate(field);
  }

  /** Live gate on the pay button — no submit needed to know it's incomplete. */
  const blocking = useMemo(
    () => Object.keys(collectErrors()).length > 0 || (requireTerms && !terms),
    [artist, email, requireTerms, terms],
  );

  const errorCount = FIELD_ORDER.filter((f) => errors[f]).length;

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const next = collectErrors();
    FIELD_ORDER.forEach((f) => touched.current.add(f));
    setErrors(next);
    const missing = FIELD_ORDER.filter((f) => next[f]);
    if (missing.length > 0) {
      document.getElementById(INPUT_ID[missing[0]!])?.focus();
      setError(
        missing.length === 1
          ? "One field needs your attention before you can pay."
          : `${missing.length} fields need your attention before you can pay.`,
      );
      return;
    }

    if (requireTerms && !terms) {
      document.getElementById("pn-terms")?.focus();
      setError("Please confirm the one-shoot terms before you can pay.");
      return;
    }



    setBusy(true);
    try {
      const result = await createTrackRequest({
        data: {
          artist: artist.trim(),
          email: email.trim(),
          packageLabel: `${packageLabel} — ${
            orderKind === "bundle" ? "10-Track Bundle" : "Single Track"
          } (paid)`,
          fileName: null,
          link: null,
          notes: notes?.trim() ? notes.trim().slice(0, 3900) : null,
          acknowledged: true,
        },
      });
      if (!result.ok || !result.reference) {
        setError("We couldn't create your order. Please try again in a moment.");
        return;
      }
      // Order created — the saved draft is no longer needed.
      ["artist", "email"].forEach((f) => clearDraft(`${draftKey}.${f}`));
      onSubmitted({ reference: result.reference, email: email.trim() });
    } catch {
      setError("We couldn't create your order. Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const field =
    "w-full border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-[#4b8bff]";
  const fieldState = (invalid: boolean) =>
    invalid ? `${field} border-[#e11d2e] focus:border-[#e11d2e]` : field;
  const errorCls = "mt-1.5 text-xs text-status-accent";
  const labelCls = "text-xs uppercase tracking-widest text-muted-foreground";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Order ${packageLabel}`}
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto overlay-scrim bg-foreground/40 p-4 backdrop-blur-md sm:p-8"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        noValidate
        className="relative my-auto w-full max-w-lg border border-border bg-background/95 p-8"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close order form"
          className="absolute end-3 top-3 rounded-full studio-glass p-2 text-foreground hover:bg-white"
        >
          <X size={16} />
        </button>

        <div className="eyebrow">
          <span className="text-[#4b8bff]">/ Pay Now</span>
        </div>
        <h2 className="mt-2 font-display text-2xl font-bold text-white">{packageLabel}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Single track — {priceLabel}. Just your name and email — you'll send files, links and
          project details right after payment.
        </p>

        {priceId && currency && (
          <PriceBreakdown
            priceId={priceId}
            currency={currency}
            label="Single track"
            className="mt-4"
          />
        )}

        {/* Announces validation state to screen readers as it changes. */}
        <p role="status" aria-live="polite" className="sr-only">
          {errorCount > 0
            ? `${errorCount} field${errorCount === 1 ? "" : "s"} need attention before payment.`
            : ""}
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label htmlFor="pn-artist" className={labelCls}>
              Name{" "}
              <span className="text-[#e11d2e]" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id="pn-artist"
              maxLength={200}
              value={artist}
              autoComplete="name"
              onChange={(e) => {
                setArtist(e.target.value);
                revalidate("artist", { artist: e.target.value });
              }}
              onBlur={() => markTouched("artist")}
              aria-required="true"
              aria-invalid={!!errors.artist}
              aria-describedby={errors.artist ? "pn-artist-error" : undefined}
              className={`mt-1 ${fieldState(!!errors.artist)}`}
            />
            {errors.artist && (
              <p id="pn-artist-error" role="alert" className={errorCls}>
                {errors.artist}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="pn-email" className={labelCls}>
              Email{" "}
              <span className="text-[#e11d2e]" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id="pn-email"
              type="email"
              maxLength={255}
              value={email}
              autoComplete="email"
              onChange={(e) => {
                setEmail(e.target.value);
                revalidate("email", { email: e.target.value });
              }}
              onBlur={() => markTouched("email")}
              aria-required="true"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "pn-email-error" : undefined}
              className={`mt-1 ${fieldState(!!errors.email)}`}
            />
            {errors.email && (
              <p id="pn-email-error" role="alert" className={errorCls}>
                {errors.email}
              </p>
            )}
          </div>
        </div>

        {requireTerms && (
          <label
            htmlFor="pn-terms"
            className="mt-4 flex cursor-pointer items-start gap-3 border border-border p-4 text-sm leading-relaxed text-white/85"
          >
            <input
              id="pn-terms"
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              className="mt-0.5 h-5 w-5 flex-none accent-[#e11d2e]"
            />
            <span>
              I understand this is a one-shoot deal — 0 revisions, delivery is final, and video
              sales are non-refundable.
            </span>
          </label>
        )}



        {error && (
          <p
            role="alert"
            className="mt-4 border border-[#e11d2e]/60 bg-[#e11d2e]/10 p-3 text-sm text-[#e11d2e]"
          >
            {error}
          </p>
        )}

        {applePay && (
          <button
            type="submit"
            disabled={busy}
            aria-disabled={busy || blocking}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-3.5 text-base font-semibold text-black transition-all hover:opacity-90 disabled:opacity-60 aria-disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path d="M16.36 12.7c-.02-2.05 1.68-3.03 1.75-3.08-.95-1.39-2.44-1.58-2.97-1.6-1.27-.13-2.47.74-3.11.74-.64 0-1.63-.72-2.68-.7-1.38.02-2.65.8-3.36 2.03-1.43 2.48-.37 6.15 1.03 8.16.68.98 1.5 2.09 2.57 2.05 1.03-.04 1.42-.67 2.67-.67s1.6.67 2.69.65c1.11-.02 1.81-1 2.49-1.99.78-1.14 1.11-2.24 1.13-2.3-.03-.01-2.17-.83-2.19-3.29zM14.4 6.6c.56-.69.94-1.63.84-2.6-.81.04-1.8.55-2.38 1.22-.52.6-.98 1.57-.86 2.49.9.07 1.83-.46 2.4-1.11z" />
            </svg>
            {busy ? "Creating your order…" : "Pay with Apple Pay"}
          </button>
        )}

        {googlePay && (
          <button
            type="submit"
            disabled={busy}
            aria-disabled={busy || blocking}
            className={`${applePay ? "mt-3" : "mt-6"} flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-3.5 text-base font-semibold text-black transition-all hover:opacity-90 disabled:opacity-60 aria-disabled:opacity-60`}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M21.6 12.23c0-.68-.06-1.34-.18-1.96H12v3.71h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.74 2.98-4.3 2.98-7.27z"
              />
              <path
                fill="#34A853"
                d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.24-2.5c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.75-5.59-4.1H3.06v2.58A10 10 0 0 0 12 22z"
              />
              <path
                fill="#FBBC05"
                d="M6.41 13.93a6 6 0 0 1 0-3.86V7.49H3.06a10 10 0 0 0 0 9.02l3.35-2.58z"
              />
              <path
                fill="#EA4335"
                d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.87-2.87C16.95 2.98 14.7 2 12 2a10 10 0 0 0-8.94 5.49l3.35 2.58C7.2 7.73 9.4 5.98 12 5.98z"
              />
            </svg>
            {busy ? "Creating your order…" : "Pay with Google Pay"}
          </button>
        )}

        {hasWallet && (
          <div className="mt-3 flex items-center gap-3 text-[11px] uppercase tracking-widest text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          aria-disabled={busy || blocking}
          className={`${hasWallet ? "mt-3" : "mt-6"} w-full border border-[#4b8bff] bg-[#4b8bff] px-4 py-3 text-sm font-semibold uppercase tracking-widest text-black transition-all hover:opacity-90 disabled:opacity-60 aria-disabled:opacity-60`}
        >
          {busy
            ? "Creating your order…"
            : `${hasWallet ? "Card or other method" : "Continue to payment"} — ${priceLabel}`}
        </button>
        <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">
          {hasWallet
            ? `${applePay && googlePay ? "Apple Pay and Google Pay appear" : applePay ? "Apple Pay appears" : "Google Pay appears"} as one-tap at the top of the secure payment sheet. `
            : ""}
          By continuing you confirm you own or control the rights to the material you submit.
        </p>


      </form>
    </div>
  );
}
