import { createServerFn } from "@tanstack/react-start";
import { limitBy, RATE_LIMITS } from "@/lib/rate-limit";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { type StripeEnv, createStripeClient, getStripeErrorMessage } from "@/lib/stripe.server";
import { artistBundleFor } from "@/lib/artist-tokens";

type CheckoutResult = { clientSecret: string } | { error: string };

/** Current signed-in user's Artist Token balance plus the tracks they own. */
export const getArtistTokenState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ balance: number; unlocked: string[] }> => {
    const [{ data: balanceRow }, { data: owned }] = await Promise.all([
      context.supabase
        .from("artist_token_balances")
        .select("balance")
        .eq("user_id", context.userId)
        .maybeSingle(),
      context.supabase
        .from("artist_track_downloads")
        .select("track_id")
        .eq("user_id", context.userId),
    ]);
    return {
      balance: balanceRow?.balance ?? 0,
      unlocked: (owned ?? []).map((row) => row.track_id as string),
    };
  });

/** Starts an embedded Stripe Checkout for one Artist Token bundle. */
export const createArtistTokenCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { priceId: string; returnUrl: string; environment: StripeEnv }) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(data.priceId)) throw new Error("Invalid priceId");
    return data;
  })
  .handler(async ({ data, context }): Promise<CheckoutResult> => {
    try {
      const bundle = artistBundleFor(data.priceId);
      if (!bundle) return { error: "That Artist Token pack isn't available." };

      const { allowedSiteUrl, defaultSiteOrigin } = await import("@/lib/site-origin.server");
      const returnUrl =
        allowedSiteUrl(data.returnUrl) ??
        `${defaultSiteOrigin()}/?artist_token_session={CHECKOUT_SESSION_ID}`;

      const stripe = createStripeClient(data.environment);
      const prices = await stripe.prices.list({ lookup_keys: [data.priceId] });
      if (!prices.data.length) return { error: "Artist Token pricing isn't published yet." };
      const price = prices.data[0];

      const session = await stripe.checkout.sessions.create({
        line_items: [{ price: price.id, quantity: 1 }],
        mode: "payment",
        ui_mode: "embedded_page",
        return_url: returnUrl,
        payment_intent_data: {
          description: `Artist Tokens — ${bundle.name} (${bundle.tokens} downloads)`,
        },
        managed_payments: { enabled: true },
        metadata: {
          kind: "artist_tokens",
          priceId: data.priceId,
          userId: context.userId,
        },
      } as import("stripe").Stripe.Checkout.SessionCreateParams);

      return { clientSecret: session.client_secret ?? "" };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

type CreditResult =
  | { ok: true; credited: number; balance: number; alreadyCredited: boolean; paid: boolean }
  | { ok: false; error: string };

/**
 * Credits a completed Artist Token purchase. Idempotent: the purchase row is
 * keyed on the Stripe session id, so a refresh can never double-credit.
 */
export const creditArtistTokenPurchase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; environment: StripeEnv }) => {
    if (!/^cs_[A-Za-z0-9_]+$/.test(data.sessionId)) throw new Error("Invalid sessionId");
    return data;
  })
  .handler(async ({ data, context }): Promise<CreditResult> => {
    try {
      const stripe = createStripeClient(data.environment);
      const session = await stripe.checkout.sessions.retrieve(data.sessionId);

      if (session.metadata?.["kind"] !== "artist_tokens") {
        return { ok: false, error: "That checkout wasn't an Artist Token purchase." };
      }
      if (session.metadata?.["userId"] !== context.userId) {
        return { ok: false, error: "That purchase belongs to a different account." };
      }

      const paid =
        session.payment_status === "paid" || session.payment_status === "no_payment_required";
      const bundle = artistBundleFor(session.metadata?.["priceId"] ?? "");
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      if (!paid || !bundle) {
        const { data: balanceRow } = await supabaseAdmin
          .from("artist_token_balances")
          .select("balance")
          .eq("user_id", context.userId)
          .maybeSingle();
        return { ok: true, credited: 0, balance: balanceRow?.balance ?? 0, alreadyCredited: false, paid };
      }

      const { data: credit, error } = await supabaseAdmin
        .rpc("credit_artist_token_purchase", {
          _user_id: context.userId,
          _session_id: session.id,
          _price_id: bundle.priceId,
          _tokens: bundle.tokens,
          _amount_total: (session.amount_total ?? null) as number,
          _currency: (session.currency ?? null) as string,
        })
        .maybeSingle();

      if (error || !credit) {
        console.error("Artist token crediting failed:", error?.message);
        return { ok: false, error: "Payment received, but crediting failed. Contact support." };
      }

      if (!credit.already_credited) {
        const credited = credit.credited ?? bundle.tokens;
        const balance = credit.balance ?? 0;
        const { notifyUser } = await import("./notifications.server");
        await notifyUser({
          userId: context.userId,
          kind: "token_credit",
          title: `${credited} Artist Tokens added`,
          body: `Your purchase is complete. ${credited} Artist Token${credited === 1 ? " was" : "s were"} credited to your account. New balance: ${balance}.`,
          reference: session.id,
          emailless: true,
        });
        const { sendTokenPurchaseReceipt } = await import("./resend.server");
        await sendTokenPurchaseReceipt({
          userId: context.userId,
          amount: credited,
          balance,
          tokenKind: "artist",
          fallbackEmail: session.customer_details?.email ?? session.customer_email,
        });
      }

      return {
        ok: true,
        credited: credit.credited ?? 0,
        balance: credit.balance ?? 0,
        alreadyCredited: credit.already_credited ?? false,
        paid: true,
      };
    } catch (error) {
      return { ok: false, error: getStripeErrorMessage(error) };
    }
  });

type UnlockResult =
  | {
      ok: true;
      balance: number;
      alreadyOwned: boolean;
      url: string;
      fileName: string;
      expiresAt: number;
    }
  | { ok: false; error: string; balance: number };

/**
 * Spends one Artist Token to unlock a catalog track download. Already-unlocked
 * tracks are free forever — the track URL is resolved server-side from the
 * catalog so the browser can never ask for something that isn't for sale.
 */
export const unlockTrackDownload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { trackId: string }) => {
    if (!data?.trackId || typeof data.trackId !== "string" || data.trackId.length > 200) {
      throw new Error("Invalid trackId");
    }
    return { trackId: data.trackId };
  })
  .handler(async ({ data, context }): Promise<UnlockResult> => {
    limitBy("unlockTrackDownload", context.userId, RATE_LIMITS.tokenSpend, "download unlocks");
    const { STREAM_TRACKS } = await import("@/lib/radio-tracks");
    const track = STREAM_TRACKS.find((t) => t.id === data.trackId);
    if (!track) return { ok: false, error: "That track isn't in the catalog.", balance: 0 };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .rpc("redeem_artist_track_download", {
        _user_id: context.userId,
        _track_id: track.id,
        _track_title: track.title,
        _track_artist: track.artist,
      })
      .maybeSingle();

    if (error || !row) {
      return { ok: false, error: "We couldn't complete that download. Try again.", balance: 0 };
    }
    if (!row.ok) {
      return {
        ok: false,
        error: row.reason ?? "Not enough Artist Tokens.",
        balance: row.balance ?? 0,
      };
    }

    const safeTitle = `${track.artist} - ${track.title}`.replace(/[^\w\s.-]+/g, "").trim();
    const fileName = `${safeTitle || track.id}.mp3`;
    const { signDownloadToken, downloadPathFor } = await import("@/lib/download-signing.server");
    const signed = await signDownloadToken({
      trackId: track.id,
      userId: context.userId,
      fileName,
    });
    return {
      ok: true,
      balance: row.balance ?? 0,
      alreadyOwned: row.already_owned ?? false,
      url: downloadPathFor(signed.token),
      fileName,
      expiresAt: signed.expiresAt,
    };
  });

export type ArtistLedgerEntry = {
  id: string;
  createdAt: string;
  delta: number;
  kind: string;
  reference: string | null;
  note: string | null;
  balanceAfter: number | null;
  stripeSessionId: string | null;
  amountTotal: number | null;
  currency: string | null;
};

/** Full Artist Token history for the signed-in user, newest first. */
export const getArtistTokenLedger = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ balance: number; entries: ArtistLedgerEntry[] }> => {
    const [{ data: balanceRow }, { data: ledger }, { data: purchases }] = await Promise.all([
      context.supabase
        .from("artist_token_balances")
        .select("balance")
        .eq("user_id", context.userId)
        .maybeSingle(),
      context.supabase
        .from("artist_token_ledger")
        .select("id, created_at, delta, kind, reference, note, balance_after")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(500),
      context.supabase
        .from("artist_token_purchases")
        .select("stripe_session_id, amount_total, currency")
        .eq("user_id", context.userId),
    ]);

    const bySession = new Map(
      (purchases ?? []).map((p) => [p.stripe_session_id as string, p]),
    );

    return {
      balance: balanceRow?.balance ?? 0,
      entries: (ledger ?? []).map((row) => {
        const purchase = row.reference ? bySession.get(row.reference) : undefined;
        return {
          id: row.id as string,
          createdAt: row.created_at as string,
          delta: row.delta as number,
          kind: row.kind as string,
          reference: (row.reference as string | null) ?? null,
          note: (row.note as string | null) ?? null,
          balanceAfter: (row.balance_after as number | null) ?? null,
          stripeSessionId: purchase ? (purchase.stripe_session_id as string) : null,
          amountTotal: purchase ? ((purchase.amount_total as number | null) ?? null) : null,
          currency: purchase ? ((purchase.currency as string | null) ?? null) : null,
        };
      }),
    };
  });

export type UnlockedDownload = {
  trackId: string;
  title: string;
  artist: string;
  album: string | null;
  unlockedAt: string;
  available: boolean;
  fileName: string;
};

/** Every track this account has permanently unlocked, newest first. */
export const getArtistDownloads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ balance: number; downloads: UnlockedDownload[] }> => {
    const { STREAM_TRACKS } = await import("@/lib/radio-tracks");
    const byId = new Map(STREAM_TRACKS.map((t) => [t.id, t]));

    const [{ data: balanceRow }, { data: rows }] = await Promise.all([
      context.supabase
        .from("artist_token_balances")
        .select("balance")
        .eq("user_id", context.userId)
        .maybeSingle(),
      context.supabase
        .from("artist_track_downloads")
        .select("track_id, track_title, track_artist, created_at")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(500),
    ]);

    return {
      balance: balanceRow?.balance ?? 0,
      downloads: (rows ?? []).map((row) => {
        const track = byId.get(row.track_id as string);
        const title = track?.title ?? (row.track_title as string | null) ?? (row.track_id as string);
        const artist = track?.artist ?? (row.track_artist as string | null) ?? "Hybrid AI Records";
        const safe = `${artist} - ${title}`.replace(/[^\w\s.-]+/g, "").trim();
        return {
          trackId: row.track_id as string,
          title,
          artist,
          album: (track as { album?: string } | undefined)?.album ?? null,
          unlockedAt: row.created_at as string,
          available: Boolean(track?.src),
          fileName: `${safe || (row.track_id as string)}.mp3`,
        };
      }),
    };
  });

type DownloadLinkResult =
  | { ok: true; url: string; fileName: string; expiresAt: number }
  | { ok: false; error: string };

/**
 * Mints a fresh short-lived signed download link for a track the account
 * already owns. Ownership is re-checked on every mint, and the link expires in
 * minutes so a copied URL is useless.
 */
export const createTrackDownloadLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { trackId: string }) => {
    if (!data?.trackId || typeof data.trackId !== "string" || data.trackId.length > 200) {
      throw new Error("Invalid trackId");
    }
    return { trackId: data.trackId };
  })
  .handler(async ({ data, context }): Promise<DownloadLinkResult> => {
    const { data: owned } = await context.supabase
      .from("artist_track_downloads")
      .select("track_id")
      .eq("user_id", context.userId)
      .eq("track_id", data.trackId)
      .maybeSingle();
    if (!owned) return { ok: false, error: "You haven't unlocked that track yet." };

    const { STREAM_TRACKS } = await import("@/lib/radio-tracks");
    const track = STREAM_TRACKS.find((item) => item.id === data.trackId);
    if (!track) return { ok: false, error: "That track isn't in the catalog right now." };

    const safeTitle = `${track.artist} - ${track.title}`.replace(/[^\w\s.-]+/g, "").trim();
    const fileName = `${safeTitle || track.id}.mp3`;
    const { signDownloadToken, downloadPathFor } = await import("@/lib/download-signing.server");
    const signed = await signDownloadToken({
      trackId: track.id,
      userId: context.userId,
      fileName,
    });
  return { ok: true, url: downloadPathFor(signed.token), fileName, expiresAt: signed.expiresAt };
});

/** Aggregate download counts per catalog track for popularity sorting. Anonymous totals only. */
export const getArtistTrackDownloadCounts = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ trackId: string; count: number }[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("artist_track_downloads")
      .select("track_id");
    if (error || !data) return [];
    const counts = new Map<string, number>();
    for (const row of data) {
      const id = row.track_id as string;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([trackId, count]) => ({ trackId, count }));
  },
);


