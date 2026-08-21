import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Permission regression guard for the pricing surcharge configuration.
 *
 * Two shapes must hold at once:
 *  - Public/storefront pages read the sanitized `pricing_settings_public`
 *    view (and, at most, the safe columns of the base table). The
 *    `updated_by` column holds internal admin user IDs and must never be
 *    reachable by `anon` or `authenticated`.
 *  - /admin/pricing keeps working: admins can still read the last-editor
 *    identity through an admin-role-gated server function that runs with
 *    privileged access, and admins can still read their own role rows.
 *
 * Database assertions are skipped where the sandbox has no managed
 * connection; the source-level assertions always run.
 */
const HAS_DB = Boolean(process.env["PGHOST"]);

function sql(query: string): string[][] {
  const out = execFileSync("psql", ["-At", "-F", "\u0001", "-c", query], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split("\u0001"));
}

const PUBLIC_ROLES = ["anon", "authenticated"] as const;
/** Columns a storefront price quote legitimately needs. */
const SAFE_COLUMNS = ["key", "surcharge_bps", "created_at", "updated_at"] as const;
const RESTRICTED_COLUMNS = ["updated_by"] as const;

describe.skipIf(!HAS_DB)("pricing_settings column permissions", () => {
  it("hides restricted columns from public roles", () => {
    for (const role of PUBLIC_ROLES) {
      for (const column of RESTRICTED_COLUMNS) {
        const [[granted]] = sql(
          `select has_column_privilege('${role}','public.pricing_settings','${column}','select')::text`,
        );
        expect(
          granted,
          `${role} must not read pricing_settings.${column}`,
        ).toBe("false");
      }
    }
  });

  it("keeps the sanitized public view readable so pricing pages still quote", () => {
    const [[viewReadable]] = sql(
      `select has_table_privilege('anon','public.pricing_settings_public','select')::text`,
    );
    expect(viewReadable).toBe("true");

    const columns = sql(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'pricing_settings_public'`,
    ).map(([c]) => c);

    for (const column of SAFE_COLUMNS) expect(columns).toContain(column);
    for (const column of RESTRICTED_COLUMNS) expect(columns).not.toContain(column);
  });

  it("never grants public roles write access to the pricing configuration", () => {
    for (const role of PUBLIC_ROLES) {
      for (const priv of ["insert", "update", "delete"]) {
        const [[granted]] = sql(
          `select has_table_privilege('${role}','public.pricing_settings','${priv}')::text`,
        );
        expect(granted, `${role} must not ${priv} pricing_settings`).toBe("false");
      }
    }
  });

  it("keeps RLS enabled on the pricing table", () => {
    const [[enabled]] = sql(
      `select relrowsecurity::text from pg_class
        where oid = 'public.pricing_settings'::regclass`,
    );
    expect(enabled).toBe("true");
  });

  it("lets admins read their own role rows so the admin gate can resolve", () => {
    const policies = sql(
      `select policyname, cmd, roles::text, coalesce(qual,'')
         from pg_policies where schemaname='public' and tablename='user_roles'`,
    );
    const selectPolicies = policies.filter(([, cmd]) => cmd === "SELECT");
    expect(selectPolicies.length).toBeGreaterThan(0);
    expect(
      selectPolicies.some(([, , roles, qual]) =>
        roles?.includes("authenticated") && qual?.includes("auth.uid()"),
      ),
    ).toBe(true);
  });
});

describe("/admin/pricing access path", () => {
  const fns = readFileSync("src/lib/pricing-settings.functions.ts", "utf8");
  const page = readFileSync("src/routes/_authenticated/admin.pricing.tsx", "utf8");
  const server = readFileSync("src/lib/pricing-settings.server.ts", "utf8");

  it("gates the last-editor identity behind an admin role check", () => {
    const audit = fns.slice(fns.indexOf("export const getSurchargeAudit"));
    expect(audit).toContain("requireSupabaseAuth");
    expect(audit).toContain('.from("user_roles")');
    expect(audit).toContain('.in("role", ["admin"])');
    expect(audit).toContain('throw new Error("Forbidden")');
  });

  it("keeps the public settings read free of the admin identity", () => {
    const publicRead = fns.slice(
      fns.indexOf("export const getSurchargeSettings"),
      fns.indexOf("export const updateSurchargeSettings"),
    );
    expect(publicRead).not.toContain("requireSupabaseAuth");
    expect(publicRead).not.toContain("updated_by");
    expect(server).toContain('.from("pricing_settings_public")');
    // The public read path must not select the admin identity column.
    const publicHelper = server.slice(
      server.indexOf("export async function readSurchargeSettings"),
      server.indexOf("export async function writeSurchargeSettings"),
    );
    expect(publicHelper).not.toContain("updated_by");
  });

  it("still renders the admin surcharge editor and its audit line", () => {
    expect(page).toContain("getSurchargeAudit");
    expect(page).toContain("updateSurchargeSettings");
    expect(page).toContain("Last changed");
  });
});
