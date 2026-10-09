import { createHash, randomBytes } from "node:crypto";

import { TooLostError } from "@/lib/too-lost/errors";

export const RELEASE_SCOPES = "read:profile read:releases write:releases";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  return { verifier, challenge, state };
}

/** API key first, then the source static bearer. Never logged. */
export function staticAccessToken(): string {
  return trimEnv("TOO_LOST_API_KEY") || trimEnv("TOOLOST_ACCESS_TOKEN");
}

export function redirectUri(): string | null {
  if (trimEnv("TOOLOST_REDIRECT_URI")) return trimEnv("TOOLOST_REDIRECT_URI");
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000/api/auth/callback";
  return null;
}

export function oauthConfigured(): boolean {
  return Boolean(trimEnv("TOOLOST_CLIENT_ID") && trimEnv("TOOLOST_CLIENT_SECRET") && redirectUri());
}

export function authorizeUrl(): string {
  return trimEnv("TOOLOST_AUTHORIZE_URL") || "https://sandbox.toolost.com/oauth/authorize";
}

export function tokenUrl(): string {
  return trimEnv("TOOLOST_TOKEN_URL") || "https://sandbox.toolost.com/oauth/token";
}

/**
 * Static API key wins so a server distribution call does not start a browser OAuth dance.
 * Mock is refused in production, matching the source client.
 */
export function authMode(): "mock" | "static" | "oauth" | "none" {
  if (staticAccessToken()) return "static";
  if (oauthConfigured()) {
    void authorizeUrl();
    void tokenUrl();
    return "oauth";
  }
  if (trimEnv("TOOLOST_MOCK") === "true" && process.env.NODE_ENV !== "production") return "mock";
  return "none";
}

export function buildAuthorizeUrl(args: { state: string; codeChallenge: string }): string {
  const url = new URL(authorizeUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", trimEnv("TOOLOST_CLIENT_ID"));
  url.searchParams.set("redirect_uri", redirectUri() || "");
  url.searchParams.set("scope", RELEASE_SCOPES);
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri() || "",
    code_verifier: verifier,
    client_id: trimEnv("TOOLOST_CLIENT_ID"),
    client_secret: trimEnv("TOOLOST_CLIENT_SECRET"),
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: trimEnv("TOOLOST_CLIENT_ID"),
    client_secret: trimEnv("TOOLOST_CLIENT_SECRET"),
  });
}

async function tokenRequest(fields: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(fields),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    message?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new TooLostError(body.error_description || body.message || "Token exchange failed.", res.status);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}
