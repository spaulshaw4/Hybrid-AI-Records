import type { SupabaseClient } from "@supabase/supabase-js";

import { vaultAdminClient } from "@/lib/vault-admin.server";
import {
  isSubscriptionTier,
  SUBSCRIPTION_TIERS,
  type SubscriptionTierId,
} from "@/lib/subscription-plans";

const LEDGER_USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProfileRow = {
  user_id?: string | null;
  subscription_tier?: string | null;
  d_tokens?: number | null;
};

function webhookFailure(): Response {
  return Response.json({ error: "Webhook error" }, { status: 500 });
}

function received(): Response {
  return Response.json({ received: true });
}

function isLedgerUserId(userId: string): boolean {
  return LEDGER_USER_ID.test(userId);
}

function stripeId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id.trim();
  }
  return "";
}

function stringMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function admin(): SupabaseClient | Response {
  try {
    return vaultAdminClient();
  } catch {
    console.error("[stripe-subscription] ledger unavailable");
    return webhookFailure();
  }
}

async function applyGrant(
  supabase: SupabaseClient,
  args: {
    userId: string;
    grantKey: string;
    tier: SubscriptionTierId;
    kind: "initial" | "cycle";
    mode: "set" | "add";
    customerId: string;
    subscriptionId: string;
  },
): Promise<Response> {
  const allowance = SUBSCRIPTION_TIERS[args.tier];
  const { error } = await supabase.rpc("apply_subscription_grant", {
    _user_id: args.userId,
    _grant_key: args.grantKey,
    _tier: args.tier,
    _kind: args.kind,
    _d_tokens: allowance.dTokens,
    _hybrid_tokens: allowance.hybridTokens,
    _stripe_customer_id: args.customerId,
    _stripe_subscription_id: args.subscriptionId,
    _mode: args.mode,
  });
  if (error) {
    console.error("[stripe-subscription] grant failed");
    return webhookFailure();
  }
  return received();
}

async function lookupSubscriber(
  supabase: SupabaseClient,
  hint: { userId: string; customerId: string; subscriptionId: string },
): Promise<{ userId: string; tier: SubscriptionTierId } | null> {
  const filters: Array<[string, string]> = [];
  if (hint.subscriptionId) filters.push(["stripe_subscription_id", hint.subscriptionId]);
  if (hint.customerId) filters.push(["stripe_customer_id", hint.customerId]);
  if (isLedgerUserId(hint.userId)) filters.push(["user_id", hint.userId]);

  for (const [column, value] of filters) {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, subscription_tier")
      .eq(column, value)
      .maybeSingle();
    if (error || !data) continue;
    const row = data as ProfileRow;
    const userId = row.user_id?.trim() ?? "";
    if (isLedgerUserId(userId) && isSubscriptionTier(row.subscription_tier)) {
      return { userId, tier: row.subscription_tier };
    }
  }
  return null;
}

/**
 * First subscription checkout replaces the tier buckets.
 * One-time packs (mode payment, including d5/d10/d25) never reach this function.
 */
export async function fulfillSubscriptionCheckout(session: Record<string, unknown>): Promise<Response> {
  if (session.mode !== "subscription") return received();
  if (session.payment_status === "unpaid") return received();

  const metadata = stringMetadata(session.metadata);
  const tier = metadata.tier?.trim() ?? "";
  const userId = metadata.userId?.trim() ?? "";
  if (!isSubscriptionTier(tier) || !isLedgerUserId(userId)) return received();

  const sessionId = typeof session.id === "string" ? session.id.trim() : "";
  if (!sessionId) return webhookFailure();

  const client = admin();
  if (client instanceof Response) return client;

  return applyGrant(client, {
    userId,
    grantKey: `checkout:${sessionId}`,
    tier,
    kind: "initial",
    mode: "set",
    customerId: stripeId(session.customer),
    subscriptionId: stripeId(session.subscription),
  });
}

/** Monthly replenishment. subscription_create is ignored so the first invoice does not stack on the checkout grant. */
export async function fulfillSubscriptionInvoice(invoice: Record<string, unknown>): Promise<Response> {
  if (invoice.billing_reason !== "subscription_cycle") return received();

  const parent = invoice.parent;
  const parentDetails =
    parent && typeof parent === "object"
      ? (parent as { subscription_details?: unknown }).subscription_details
      : undefined;
  const parentMeta =
    parentDetails && typeof parentDetails === "object"
      ? stringMetadata((parentDetails as { metadata?: unknown }).metadata)
      : {};
  const parentSub =
    parentDetails && typeof parentDetails === "object"
      ? stripeId((parentDetails as { subscription?: unknown }).subscription)
      : "";
  const details = invoice.subscription_details;
  const detailsMeta =
    details && typeof details === "object"
      ? stringMetadata((details as { metadata?: unknown }).metadata)
      : {};
  const lines = invoice.lines;
  const lineList =
    lines && typeof lines === "object" && Array.isArray((lines as { data?: unknown }).data)
      ? (lines as { data: unknown[] }).data
      : [];
  const lineMeta = lineList.reduce<Record<string, string>>((acc, line) => {
    if (line && typeof line === "object") {
      Object.assign(acc, stringMetadata((line as { metadata?: unknown }).metadata));
    }
    return acc;
  }, {});
  const metadata = { ...lineMeta, ...detailsMeta, ...parentMeta, ...stringMetadata(invoice.metadata) };

  const invoiceId = typeof invoice.id === "string" ? invoice.id.trim() : "";
  if (!invoiceId) return webhookFailure();

  const hint = {
    userId: (metadata.userId ?? "").trim(),
    tier: (metadata.tier ?? "").trim(),
    customerId: stripeId(invoice.customer),
    subscriptionId: parentSub || stripeId(invoice.subscription),
  };

  const client = admin();
  if (client instanceof Response) return client;

  const resolved =
    isLedgerUserId(hint.userId) && isSubscriptionTier(hint.tier)
      ? { userId: hint.userId, tier: hint.tier }
      : await lookupSubscriber(client, hint);
  if (!resolved) return received();

  return applyGrant(client, {
    userId: resolved.userId,
    grantKey: `invoice:${invoiceId}`,
    tier: resolved.tier,
    kind: "cycle",
    mode: "add",
    customerId: hint.customerId,
    subscriptionId: hint.subscriptionId,
  });
}

/** Cancel keeps whatever tokens the artist has not spent. */
export async function fulfillSubscriptionDeleted(subscription: Record<string, unknown>): Promise<Response> {
  const metadata = stringMetadata(subscription.metadata);
  const userId = (metadata.userId ?? "").trim();
  const subscriptionId = typeof subscription.id === "string" ? subscription.id.trim() : "";
  const customerId = stripeId(subscription.customer);
  const patch = { subscription_status: "canceled", subscription_tier: "free" };

  const client = admin();
  if (client instanceof Response) return client;

  const filters: Array<[string, string]> = [];
  if (isLedgerUserId(userId)) filters.push(["user_id", userId]);
  if (subscriptionId) filters.push(["stripe_subscription_id", subscriptionId]);
  if (customerId) filters.push(["stripe_customer_id", customerId]);
  if (filters.length === 0) return received();

  for (const [column, value] of filters) {
    const { data, error } = await client
      .from("profiles")
      .update(patch)
      .eq(column, value)
      .select("user_id");
    if (error) {
      console.error("[stripe-subscription] cancel failed");
      return webhookFailure();
    }
    if (Array.isArray(data) && data.length > 0) return received();
  }
  return received();
}
