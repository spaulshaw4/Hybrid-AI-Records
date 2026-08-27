import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type StudioSession = {
  /** Verified auth.users UUID for this request — never a static/admin fallback. */
  userId: string;
  accessToken: string;
  /** Anon-key client scoped to this user's JWT (RLS applies). */
  supabase: SupabaseClient<Database>;
};

/** Intentional 401 — must not be wrapped as a branded 500 page. */
export class UnauthorizedSessionError extends Error {
  readonly status = 401 as const;
  readonly statusCode = 401 as const;

  constructor(message = "Unauthorized session") {
    super(message);
    this.name = "UnauthorizedSessionError";
  }
}

export function unauthorizedSessionResponse(message = "Unauthorized session"): Response {
  return Response.json({ error: message }, { status: 401 });
}

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    if (isNewSupabaseApiKey(supabaseKey) && headers.get("Authorization") === `Bearer ${supabaseKey}`) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function bearerFromRequest(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token || token.split(".").length !== 3) return null;
  return token;
}

/**
 * TanStack/Vite equivalent of Next.js `@supabase/ssr` cookie auth:
 * also accepts Supabase auth cookies on the Request when no Bearer is sent.
 */
function accessTokenFromCookies(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;

  const parts = raw.split(";").map((p) => p.trim());
  const byName = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    byName.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
  }

  const direct =
    byName.get("sb-access-token") ||
    byName.get("supabase-access-token") ||
    byName.get("access_token");
  if (direct && direct.split(".").length === 3) return direct;

  // Chunked SSR cookie: sb-<ref>-auth-token / .0 / .1 …
  const baseNames = [...byName.keys()].filter(
    (name) => /^sb-[\w-]+-auth-token(?:\.\d+)?$/i.test(name) && !name.endsWith("-code-verifier"),
  );
  if (baseNames.length === 0) return null;

  const roots = new Set(baseNames.map((name) => name.replace(/\.\d+$/, "")));
  for (const root of roots) {
    const chunkKeys = baseNames
      .filter((name) => name === root || name.startsWith(`${root}.`))
      .sort((a, b) => {
        const ai = Number(a.split(".").pop());
        const bi = Number(b.split(".").pop());
        if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
        return a.localeCompare(b);
      });
    const joined = chunkKeys.map((k) => byName.get(k) ?? "").join("");
    if (!joined) continue;
    try {
      const parsed = JSON.parse(joined) as { access_token?: string } | string[];
      if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].split(".").length === 3) {
        return parsed[0];
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { access_token?: string }).access_token === "string"
      ) {
        const token = (parsed as { access_token: string }).access_token;
        if (token.split(".").length === 3) return token;
      }
    } catch {
      try {
        const decoded = Buffer.from(joined, "base64").toString("utf8");
        const parsed = JSON.parse(decoded) as { access_token?: string } | string[];
        if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
        if (parsed && typeof parsed === "object" && typeof parsed.access_token === "string") {
          return parsed.access_token;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function accessTokenFromRequest(request: Request): string | null {
  return bearerFromRequest(request) ?? accessTokenFromCookies(request);
}

async function createRequestScopedClient(accessToken: string): Promise<SupabaseClient<Database>> {
  const { backendAnonKey, backendSupabaseUrl } = await import("@/lib/supabase-env.server");
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || backendSupabaseUrl();
  const SUPABASE_PUBLISHABLE_KEY = backendAnonKey();
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new UnauthorizedSessionError();
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: {
      fetch: createSupabaseFetch(SUPABASE_PUBLISHABLE_KEY),
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Request-scoped session (TanStack equivalent of Next.js `@supabase/ssr`):
 * fresh anon client + `auth.getUser()` from Bearer or auth cookies.
 * Never service-role identity. Never hardcoded / shared UUIDs.
 */
export async function resolveStudioSession(request: Request): Promise<StudioSession> {
  const accessToken = accessTokenFromRequest(request);
  if (!accessToken) throw new UnauthorizedSessionError();

  const supabase = await createRequestScopedClient(accessToken);
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user?.id) throw new UnauthorizedSessionError();

  return {
    userId: data.user.id,
    accessToken,
    supabase,
  };
}

/**
 * Resolves the signed-in studio user from the request Bearer/cookie JWT via
 * `auth.getUser()` — the caller's real `user.id`, never a hardcoded UUID.
 */
export async function studioUserIdFromRequest(request: Request): Promise<string> {
  const session = await resolveStudioSession(request);
  return session.userId;
}

/**
 * Strict session lookup for API routes.
 * Returns null (→ 401) when unauthenticated — never remaps to a DEV UUID.
 */
export async function studioUserIdFromRequestOrDev(request: Request): Promise<string | null> {
  try {
    return await studioUserIdFromRequest(request);
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) return null;
    return null;
  }
}

/**
 * @deprecated Use `resolveStudioSession` — DEV UUID identity fallbacks are removed.
 * Kept as an alias so older call sites still enforce zero-trust auth.
 */
export async function resolveStudioSessionOrDev(
  request: Request,
): Promise<StudioSession | null> {
  try {
    return await resolveStudioSession(request);
  } catch {
    return null;
  }
}
