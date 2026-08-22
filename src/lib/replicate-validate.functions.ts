import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ReplicateKeyCheck = {
  configured: boolean;
  /** True only when the stored key looks like a raw Replicate token (r8_...). */
  looksLikeR8: boolean;
  keyLength: number;
  keyPrefix: string;
  endpoint: string;
  status: number | null;
  valid: boolean;
  account?: { username?: string; name?: string; type?: string };
  message: string;
};

/**
 * Calls Replicate's /v1/account with the configured REPLICATE_API_KEY and
 * reports whether it is an actual r8_ token that authenticates.
 * Never returns the key itself — only its shape.
 */
export const validateReplicateKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<ReplicateKeyCheck> => {
    const { replicateBaseUrl } = await import("./ai-provider.server");
    const key = process.env["REPLICATE_API_KEY"] ?? "";
    const endpoint = `${replicateBaseUrl()}/account`;
    const base = {
      configured: Boolean(key),
      looksLikeR8: key.startsWith("r8_"),
      keyLength: key.length,
      keyPrefix: key ? `${key.slice(0, 3)}…` : "",
      endpoint,
    };

    if (!key) {
      return {
        ...base,
        status: null,
        valid: false,
        message: "The engine API key is not configured.",
      };
    }

    try {
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.text();
      if (!res.ok) {
        // Never log the response body verbatim: provider errors can echo back
        // the submitted credential. Log only shape-safe diagnostics.
        console.error(
          JSON.stringify({
            scope: "replicate-key-check",
            level: "error",
            status: res.status,
            endpoint,
            keyLength: base.keyLength,
            looksLikeR8: base.looksLikeR8,
            bodyLength: body.length,
          }),
        );
        return {
          ...base,
          status: res.status,
          valid: false,
          message: base.looksLikeR8
            ? `The engine token was rejected (${res.status}). It may be revoked or lack permissions — issue a fresh token and save it in the secure form.`
            : `The stored engine key is not a raw provider token (it does not start with "r8_") and was rejected with ${res.status}. Replace it with a raw token.`,
        };
      }
      let account: ReplicateKeyCheck["account"];
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        account = {
          username: typeof parsed["username"] === "string" ? parsed["username"] : undefined,
          name: typeof parsed["name"] === "string" ? parsed["name"] : undefined,
          type: typeof parsed["type"] === "string" ? parsed["type"] : undefined,
        };
      } catch {
        account = undefined;
      }
      return {
        ...base,
        status: res.status,
        valid: true,
        account,
        message: `Authenticated as ${account?.username ?? account?.name ?? "the configured account"}.`,
      };
    } catch (err) {
      console.error("[ENGINE_KEY_CHECK] network error:", err);
      return {
        ...base,
        status: null,
        valid: false,
        message: err instanceof Error ? err.message : "Could not reach the engine provider.",
      };
    }
  });
