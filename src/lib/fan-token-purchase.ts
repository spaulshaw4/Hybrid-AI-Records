/**
 * Fan-token ($1) purchase payload: parse Stripe metadata / token.purchased
 * envelopes into the routing record Stephen is alerted on.
 *
 * Never auto-sends money. Status is always the exact string `Pending Payout`.
 */

export const PENDING_PAYOUT_STATUS = "Pending Payout";
export const TOKEN_PURCHASED_EVENT = "token.purchased";

/** Default inbox when PAYOUT_ALERT_EMAIL / ALERT_EMAIL are unset. */
export const DEFAULT_PAYOUT_ALERT_EMAIL = "spaulshaw4@gmail.com";

/** Verified-domain From for payout routing alerts (not the Resend sandbox). */
export const PAYOUT_ALERT_FROM = "Hybrid AI Records <notifications@hybrid-ai-records.com>";

const META_MAX = 500;

export type TokenPurchasedData = {
  token_amount: number;
  currency: string;
  song_title: string;
  artist_name: string;
  artist_payout_target: string;
  buyer_email: string;
  transaction_id: string;
  stripe_session_id?: string;
};

export type TokenPurchasedPayload = {
  event: typeof TOKEN_PURCHASED_EVENT;
  data: TokenPurchasedData;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clipMeta(raw: string, max = META_MAX): string {
  return raw.replace(/[\r\n\0]/g, " ").trim().slice(0, max);
}

function strField(value: unknown): string {
  if (typeof value === "string") return clipMeta(value);
  if (typeof value === "number" && Number.isFinite(value)) return clipMeta(String(value));
  return "";
}

function metaGet(meta: Record<string, unknown> | null | undefined, ...keys: string[]): string {
  if (!meta) return "";
  for (const key of keys) {
    const found = strField(meta[key]);
    if (found) return found;
  }
  return "";
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Dollars with two places, e.g. `$1.00`. */
export function formatTokenAmountUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function payoutAlertRecipient(): string {
  const override =
    process.env.PAYOUT_ALERT_EMAIL?.trim() || process.env.ALERT_EMAIL?.trim() || "";
  return override.includes("@") ? override : DEFAULT_PAYOUT_ALERT_EMAIL;
}

/**
 * Stripe Checkout Session + PaymentIntent metadata for a fan-token purchase.
 * Values are strings (Stripe requirement). Empty fields are omitted.
 */
export function buildFanTokenCheckoutMetadata(input: {
  artistName?: string | null;
  songTitle?: string | null;
  artistPayoutTarget?: string | null;
  payoutAddress?: string | null;
  buyerEmail?: string | null;
}): Record<string, string> {
  const artistName = clipMeta(input.artistName ?? "");
  const songTitle = clipMeta(input.songTitle ?? "");
  const payout = clipMeta(input.artistPayoutTarget || input.payoutAddress || "");
  const buyerEmail = clipMeta(input.buyerEmail ?? "");
  const metadata: Record<string, string> = {};
  if (artistName) metadata.artist_name = artistName;
  if (songTitle) metadata.song_title = songTitle;
  if (payout) {
    metadata.artist_payout_target = payout;
    metadata.payout_address = payout;
  }
  if (buyerEmail) metadata.buyer_email = buyerEmail;
  return metadata;
}

function tokenAmountFromStripe(amountTotal: number | null | undefined, alreadyDollars: number | null): number {
  if (alreadyDollars != null && alreadyDollars > 0 && alreadyDollars < 50) return alreadyDollars;
  if (typeof amountTotal === "number" && Number.isFinite(amountTotal)) {
    // Stripe Checkout amount_total is in the smallest currency unit (cents).
    return amountTotal / 100;
  }
  return alreadyDollars ?? 0;
}

function paymentIntentId(raw: unknown): string {
  if (typeof raw === "string") return clipMeta(raw);
  const obj = asRecord(raw);
  return obj ? strField(obj.id) : "";
}

function hasRouting(data: Pick<TokenPurchasedData, "artist_name" | "song_title" | "artist_payout_target">): boolean {
  return Boolean(data.artist_payout_target || (data.artist_name && data.song_title));
}

function isArtistTokenKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "artist_tokens" || k === "fan_token" || k === "fan_tokens";
}

function fromPurchaseData(raw: Record<string, unknown>, extras?: { stripeSessionId?: string }): TokenPurchasedPayload | null {
  const payout = metaGet(raw, "artist_payout_target", "payout_address", "artist_payout_target");
  const data: TokenPurchasedData = {
    token_amount: parseAmount(raw.token_amount) ?? 0,
    currency: (strField(raw.currency) || "USD").toUpperCase(),
    song_title: metaGet(raw, "song_title"),
    artist_name: metaGet(raw, "artist_name"),
    artist_payout_target: payout,
    buyer_email: metaGet(raw, "buyer_email"),
    transaction_id: metaGet(raw, "transaction_id"),
  };
  if (extras?.stripeSessionId) data.stripe_session_id = extras.stripeSessionId;
  else {
    const sessionId = metaGet(raw, "stripe_session_id");
    if (sessionId) data.stripe_session_id = sessionId;
  }
  if (!data.transaction_id) return null;
  if (!hasRouting(data) && data.token_amount <= 0) return null;
  if (!hasRouting(data)) return null;
  return { event: TOKEN_PURCHASED_EVENT, data };
}

function fromCheckoutSession(session: Record<string, unknown>): TokenPurchasedPayload | null {
  const paymentStatus = strField(session.payment_status).toLowerCase();
  if (paymentStatus && paymentStatus !== "paid" && paymentStatus !== "no_payment_required") {
    return null;
  }
  const metadata = asRecord(session.metadata);
  const kind = metaGet(metadata, "kind");
  if (kind && !isArtistTokenKind(kind)) return null;

  const sessionId = strField(session.id);
  const tx =
    paymentIntentId(session.payment_intent) ||
    metaGet(metadata, "transaction_id") ||
    sessionId;
  if (!tx) return null;

  const buyer =
    metaGet(metadata, "buyer_email") ||
    strField(session.customer_email) ||
    strField(asRecord(session.customer_details)?.email);

  const amountMeta = parseAmount(metaGet(metadata, "token_amount"));
  const amountTotal = parseAmount(session.amount_total);
  const payout = metaGet(metadata, "artist_payout_target", "payout_address");
  const data: TokenPurchasedData = {
    token_amount: tokenAmountFromStripe(amountTotal, amountMeta),
    currency: (strField(session.currency) || metaGet(metadata, "currency") || "USD").toUpperCase(),
    song_title: metaGet(metadata, "song_title"),
    artist_name: metaGet(metadata, "artist_name"),
    artist_payout_target: payout,
    buyer_email: buyer,
    transaction_id: tx,
  };
  if (sessionId) data.stripe_session_id = sessionId;
  if (!hasRouting(data)) return null;
  return { event: TOKEN_PURCHASED_EVENT, data };
}

function fromPaymentIntent(intent: Record<string, unknown>): TokenPurchasedPayload | null {
  const status = strField(intent.status).toLowerCase();
  if (status && status !== "succeeded") return null;
  const metadata = asRecord(intent.metadata);
  const kind = metaGet(metadata, "kind");
  if (kind && !isArtistTokenKind(kind)) return null;

  const tx = strField(intent.id) || metaGet(metadata, "transaction_id");
  if (!tx) return null;

  const amountMeta = parseAmount(metaGet(metadata, "token_amount"));
  const amount = parseAmount(intent.amount);
  const payout = metaGet(metadata, "artist_payout_target", "payout_address");
  const data: TokenPurchasedData = {
    token_amount: tokenAmountFromStripe(amount, amountMeta),
    currency: (strField(intent.currency) || "USD").toUpperCase(),
    song_title: metaGet(metadata, "song_title"),
    artist_name: metaGet(metadata, "artist_name"),
    artist_payout_target: payout,
    buyer_email: metaGet(metadata, "buyer_email"),
    transaction_id: tx,
  };
  if (!hasRouting(data)) return null;
  return { event: TOKEN_PURCHASED_EVENT, data };
}

/**
 * Accepts a `token.purchased` envelope, a Stripe Event, a Checkout Session,
 * a PaymentIntent, or a bare data object.
 */
export function parseTokenPurchased(input: unknown): TokenPurchasedPayload | null {
  const root = asRecord(input);
  if (!root) return null;

  const eventName = strField(root.event) || strField(root.type);

  if (eventName === TOKEN_PURCHASED_EVENT) {
    const data = asRecord(root.data);
    return data ? fromPurchaseData(data) : fromPurchaseData(root);
  }

  if (eventName === "checkout.session.completed" || eventName === "checkout.session.async_payment_succeeded") {
    const obj = asRecord(asRecord(root.data)?.object) ?? asRecord(root.data) ?? root;
    return fromCheckoutSession(obj);
  }

  if (eventName === "payment_intent.succeeded") {
    const obj = asRecord(asRecord(root.data)?.object) ?? asRecord(root.data) ?? root;
    return fromPaymentIntent(obj);
  }

  if (strField(root.object) === "checkout.session") {
    return fromCheckoutSession(root);
  }
  if (strField(root.object) === "payment_intent") {
    return fromPaymentIntent(root);
  }

  if (root.token_amount != null || root.transaction_id || root.artist_payout_target || root.payout_address) {
    return fromPurchaseData(root);
  }

  const nested = asRecord(root.data);
  if (nested) return fromPurchaseData(nested);

  return null;
}

export function payoutAlertSubject(data: TokenPurchasedData): string {
  const artist = data.artist_name.trim();
  const song = data.song_title.trim();
  if (artist && song) return `New Artist Token Purchase — ${artist} / ${song}`;
  return "New Artist Token Purchase";
}

export function buildPayoutAlertText(data: TokenPurchasedData): string {
  const amount = formatTokenAmountUsd(data.token_amount || 1);
  const target = data.artist_payout_target || "(missing payout target)";
  return [
    "A fan token purchase cleared. This is a routing alert only — do not auto-send money.",
    "",
    `Artist: ${data.artist_name || "(unknown)"}`,
    `Song: ${data.song_title || "(unknown)"}`,
    `Token amount: ${amount}`,
    `Artist payout target: ${target}`,
    `Buyer email: ${data.buyer_email || "(unknown)"}`,
    `Transaction ID: ${data.transaction_id}`,
    data.stripe_session_id ? `Stripe session: ${data.stripe_session_id}` : "",
    "",
    `Payout is 100% to that address (${target}).`,
    `Status: ${PENDING_PAYOUT_STATUS}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildPayoutAlertHtml(data: TokenPurchasedData): string {
  const amount = formatTokenAmountUsd(data.token_amount || 1);
  const target = data.artist_payout_target || "(missing payout target)";
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#555;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0;font-weight:600">${escapeHtml(value)}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;color:#111;line-height:1.5">
  <h2 style="margin:0 0 12px">New Artist Token Purchase</h2>
  <p style="margin:0 0 16px">A fan token purchase cleared. This is a routing alert only — do not auto-send money.</p>
  <table style="border-collapse:collapse">
    ${row("Artist", data.artist_name || "(unknown)")}
    ${row("Song", data.song_title || "(unknown)")}
    ${row("Token amount", amount)}
    ${row("Artist payout target", target)}
    ${row("Buyer email", data.buyer_email || "(unknown)")}
    ${row("Transaction ID", data.transaction_id)}
    ${data.stripe_session_id ? row("Stripe session", data.stripe_session_id) : ""}
  </table>
  <p style="margin:16px 0 0"><strong>Payout is 100% to that address</strong> (${escapeHtml(target)}).</p>
  <p style="margin:8px 0 0;color:#666">Status: ${escapeHtml(PENDING_PAYOUT_STATUS)}</p>
</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type FulfillDeps = {
  recordPendingPayout: (payload: TokenPurchasedPayload) => Promise<{ inserted: boolean }>;
  sendAlert: (payload: TokenPurchasedPayload) => Promise<{ ok: boolean }>;
};

export type FulfillResult = {
  recorded: boolean;
  inserted: boolean;
  alerted: boolean;
};

/**
 * Idempotent: first insert writes Status = Pending Payout and fires the alert.
 * Replays (same transaction_id) skip both a second row and a second email.
 */
export async function fulfillFanTokenPurchase(
  payload: TokenPurchasedPayload,
  deps: FulfillDeps,
): Promise<FulfillResult> {
  const rec = await deps.recordPendingPayout(payload);
  if (!rec.inserted) {
    return { recorded: true, inserted: false, alerted: false };
  }
  const alert = await deps.sendAlert(payload);
  return { recorded: true, inserted: true, alerted: Boolean(alert.ok) };
}
