import path from "node:path";
import { spawnSync } from "node:child_process";
import { createError, defineEventHandler, getHeader, getRequestURL, readBody } from "h3";
import { workstationPython } from "../../src/lib/workstation-python.server";

export const TOKEN_TIERS = ["artist", "hybrid", "render"] as const;
export type TokenTier = (typeof TOKEN_TIERS)[number];

const TIER_SET = new Set<string>(TOKEN_TIERS);
const EXECUTE_PREFIXES = ["/api/master/execute", "/api/pipeline/master"];

export function normalizeTokenTier(raw: unknown): TokenTier {
  const value = String(raw ?? "hybrid").toLowerCase().trim();
  return TIER_SET.has(value) ? (value as TokenTier) : "hybrid";
}

function resolvePython(): string {
  return workstationPython();
}

export function debitWorkstationToken(input: {
  userId: string;
  tokenType: TokenTier;
  tokens?: number;
  idempotencyKey?: string;
}): { ok: true; balance: number; alreadyApplied: boolean } {
  const dbPath =
    process.env.MASTER_CATALOG_DB?.trim() || "D:\\MusicDatasets\\database\\master_catalog.db";
  const script = path.resolve(process.cwd(), "scripts", "debit_user_token.py");
  const args = [
    script,
    "--db",
    dbPath,
    "--user-id",
    input.userId,
    "--token-type",
    input.tokenType,
    "--tokens",
    String(input.tokens ?? 1),
  ];
  if (input.idempotencyKey) {
    args.push("--idempotency-key", input.idempotencyKey);
  }

  const result = spawnSync(resolvePython(), args, { encoding: "utf8", timeout: 15_000 });
  let parsed: { ok?: boolean; balance?: number; already_applied?: boolean; error?: string } = {};
  try {
    parsed = JSON.parse((result.stdout || "").trim() || "{}") as typeof parsed;
  } catch {
    parsed = {};
  }

  if (result.status === 0 && parsed.ok) {
    return {
      ok: true,
      balance: Number(parsed.balance ?? 0),
      alreadyApplied: Boolean(parsed.already_applied),
    };
  }

  const balance = Number(parsed.balance ?? 0);
  throw createError({
    statusCode: parsed.error && parsed.error !== "insufficient" ? 500 : 402,
    statusMessage:
      parsed.error === "insufficient" || result.status === 2
        ? `Insufficient ${input.tokenType} tokens. Balance: ${balance}`
        : parsed.error || result.stderr || "Token debit failed",
  });
}

function requireExecuteSecret(event: Parameters<Parameters<typeof defineEventHandler>[0]>[0]): void {
  const expected = process.env.MASTER_EXECUTE_SECRET?.trim();
  if (!expected) return;
  const provided = getHeader(event, "x-execute-secret") || getHeader(event, "x-hybrid-execute-secret");
  if (provided !== expected) {
    throw createError({ statusCode: 401, statusMessage: "Authentication required" });
  }
}

export default defineEventHandler(async (event) => {
  // TanStack `/api/master/execute` already debits. Enable this h3 hook only when
  // Nitro is the sole gateway (`HYBRID_H3_TOKEN_GUARD=1`) to avoid a double burn.
  if (process.env.HYBRID_H3_TOKEN_GUARD !== "1") return;

  const url = getRequestURL(event);
  const path = url.pathname || event.node.req.url || "";
  if (!EXECUTE_PREFIXES.some((prefix) => path.startsWith(prefix))) return;
  if ((event.node.req.method || "GET").toUpperCase() !== "POST") return;

  requireExecuteSecret(event);

  const headerUser = getHeader(event, "x-user-id")?.trim();
  const headerTier = getHeader(event, "x-token-tier");
  let userId = headerUser || "";
  let tier = normalizeTokenTier(headerTier);

  if (!userId || !headerTier) {
    const body = (await readBody(event).catch(() => null)) as
      | { userId?: string; user_id?: string; tierType?: string; tokenType?: string; tier?: string }
      | null;
    if (body && typeof body === "object") {
      event.context.workstationTokenBody = body;
      userId = userId || String(body.userId || body.user_id || "").trim();
      if (!headerTier) {
        tier = normalizeTokenTier(body.tierType || body.tokenType || body.tier);
      }
    }
  }

  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "Authentication required" });
  }

  const idempotency =
    getHeader(event, "idempotency-key") || getHeader(event, "x-idempotency-key") || undefined;
  debitWorkstationToken({ userId, tokenType: tier, idempotencyKey: idempotency });
});
