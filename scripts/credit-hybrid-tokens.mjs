/**
 * Credit Hybrid Tokens for a live generation test (service-role).
 *
 * Usage:
 *   node scripts/credit-hybrid-tokens.mjs --user <auth-user-uuid> --amount 10
 *
 * Requires a real auth.users id (token_balances FK). Find yours in Supabase
 * Auth → Users, or from the studio session.
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function normalize(raw) {
  let v = (raw ?? "").trim();
  while (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

const url =
  normalize(process.env.SUPABASE_URL) ||
  normalize(process.env.NEXT_PUBLIC_SUPABASE_URL);
const serviceKey = normalize(process.env.SUPABASE_SERVICE_ROLE_KEY);
const amount = Math.max(1, Number(argValue("--amount") || process.env.CREDIT_AMOUNT || 10));
const userId = argValue("--user") || normalize(process.env.CREDIT_USER_ID);

if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

if (!userId) {
  console.error(
    "Pass --user <auth-user-uuid> (or set CREDIT_USER_ID). Dummy/dev UUIDs fail the token_balances FK.",
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function credit(targetUserId) {
  const { data: row, error: readErr } = await admin
    .from("token_balances")
    .select("balance")
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);

  const current = Number(row?.balance ?? 0);
  const next = current + amount;
  const { error: writeErr } = await admin.from("token_balances").upsert(
    {
      user_id: targetUserId,
      balance: next,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (writeErr) throw new Error(writeErr.message);

  // Best-effort audit (ignore if table/columns differ).
  await admin
    .from("token_audit_log")
    .insert({
      user_id: targetUserId,
      token_amount: amount,
      reason: "Live generation test credit (scripts/credit-hybrid-tokens.mjs)",
      balance_after: next,
    })
    .then(() => undefined)
    .catch(() => undefined);

  console.log(`Credited +${amount} → user ${targetUserId} (balance ${current} → ${next})`);
  return next;
}

const targets = new Set([userId]);

for (const id of targets) {
  try {
    await credit(id);
  } catch (err) {
    console.error(`Failed for ${id}:`, err instanceof Error ? err.message : err);
  }
}

console.log("Done. Refresh the studio and retry generate.");
