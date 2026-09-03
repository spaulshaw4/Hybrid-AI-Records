import Stripe from 'stripe';

const STRIPE_API_VERSION = '2026-03-25.dahlia' as const;

const getEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not configured`);
  return value;
};

export type StripeEnv = 'sandbox' | 'live';

const GATEWAY_STRIPE_BASE = 'https://connector-gateway.lovable.dev/stripe';

function trimEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

function firstMatchingKey(names: string[], prefixes: string[]): string | undefined {
  for (const name of names) {
    const value = trimEnv(name);
    if (prefixes.some((prefix) => value.startsWith(prefix))) return value;
  }
  return undefined;
}

/**
 * Direct Stripe secret/restricted keys from `.env`.
 * Accepts `STRIPE_SECRET_KEY` (`sk_live_…`) and the `sk_live` alias (`rk_live_…`).
 */
export function nativeStripeSecret(env: StripeEnv): string | undefined {
  if (env === 'sandbox') {
    return firstMatchingKey(
      ['sk_test', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_RESTRICTED_KEY', 'STRIPE_SECRET_KEY'],
      ['sk_test_', 'rk_test_'],
    );
  }
  return firstMatchingKey(
    ['sk_live', 'STRIPE_RESTRICTED_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_LIVE_SECRET_KEY'],
    ['sk_live_', 'rk_live_'],
  );
}

export function getConnectionApiKey(env: StripeEnv): string {
  return env === 'sandbox'
    ? getEnv('STRIPE_SANDBOX_API_KEY')
    : getEnv('STRIPE_LIVE_API_KEY');
}

export function createStripeClient(env: StripeEnv): Stripe {
  const nativeSecret = nativeStripeSecret(env);
  if (nativeSecret) {
    return new Stripe(nativeSecret, { apiVersion: STRIPE_API_VERSION });
  }

  const connectionApiKey = getConnectionApiKey(env);
  const lovableApiKey = getEnv('LOVABLE_API_KEY');

  return new Stripe(connectionApiKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient((input, init) => {
      const stripeUrl = input instanceof Request ? input.url : input.toString();
      const gatewayUrl = stripeUrl.replace('https://api.stripe.com', GATEWAY_STRIPE_BASE);
      return fetch(gatewayUrl, {
        ...init,
        headers: {
          ...Object.fromEntries(
            new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries(),
          ),
          'X-Connection-Api-Key': connectionApiKey,
          'Lovable-API-Key': lovableApiKey,
        },
      });
    }),
  });
}

export function getStripeErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as {
      message?: string; type?: string; code?: string; decline_code?: string; param?: string; requestId?: string;
      raw?: { message?: string; type?: string; code?: string; decline_code?: string; param?: string; requestId?: string };
      rawType?: string;
      statusCode?: number;
    };
    const message = e.raw?.message ?? e.message;
    if (message) {
      const details = [
        e.raw?.type ?? e.type ?? e.rawType,
        e.raw?.code ?? e.code,
        e.raw?.decline_code ?? e.decline_code,
        e.raw?.param ?? e.param,
        e.raw?.requestId ?? e.requestId,
        typeof e.statusCode === 'number' ? `http ${e.statusCode}` : null,
      ].filter(Boolean);
      return details.length ? `${message} (${details.join(', ')})` : message;
    }
  }
  return 'Stripe request failed';
}

/** Logs the full Stripe error payload to the server console for debugging. */
export function logStripeError(context: string, error: unknown): void {
  const summary = getStripeErrorMessage(error);
  console.error(`[stripe] ${context}: ${summary}`);
  try {
    console.error(
      `[stripe] ${context} raw=`,
      JSON.stringify(error, Object.getOwnPropertyNames(error as object), 2),
    );
  } catch {
    console.error(`[stripe] ${context} raw=`, error);
  }
}

