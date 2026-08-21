import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the artist-uploads storage rules.
 *
 * The upload flow depends on exactly one access shape: only a signed-in user
 * may write into their own `u/<uid>/` folder (guests go through a server-issued
 * signed upload URL after their order contact email is verified),
 * but only the uploader (`owner`) or an admin may read, replace or delete the
 * object. These tests read the live policy catalog so an accidental policy
 * drop, a widened role list, or a missing owner check fails the build instead
 * of silently exposing other artists' stems.
 *
 * Skipped automatically where the sandbox has no managed database connection.
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

type Policy = {
  name: string;
  cmd: string;
  roles: string;
  qual: string;
  withCheck: string;
};

function loadPolicies(): Policy[] {
  return sql(
    `select policyname, cmd, roles::text, coalesce(qual,''), coalesce(with_check,'')
       from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and (coalesce(qual,'') || coalesce(with_check,'')) like '%artist-uploads%'
      order by policyname`,
  ).map(([name, cmd, roles, qual, withCheck]) => ({
    name: name ?? "",
    cmd: cmd ?? "",
    roles: roles ?? "",
    qual: qual ?? "",
    withCheck: withCheck ?? "",
  }));
}

/** The owner-or-admin predicate every read/write policy must carry. */
function isOwnerOrAdmin(expr: string) {
  const normalized = expr.replace(/\s+/g, " ");
  return (
    normalized.includes("owner = auth.uid()") &&
    normalized.includes("private.has_role(auth.uid(), 'admin'::app_role)")
  );
}

describe.skipIf(!HAS_DB)("artist-uploads storage RLS", () => {
  const policies = HAS_DB ? loadPolicies() : [];
  const byCmd = (cmd: string) => policies.filter((p) => p.cmd === cmd);

  it("keeps row level security enabled on storage.objects", () => {
    const [row] = sql(
      `select c.relrowsecurity::text from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'storage' and c.relname = 'objects'`,
    );
    expect(row?.[0]).toBe("true");
  });

  it("has exactly one policy per read/modify command", () => {
    expect(byCmd("SELECT")).toHaveLength(1);
    expect(byCmd("UPDATE")).toHaveLength(1);
    expect(byCmd("DELETE")).toHaveLength(1);
    expect(byCmd("INSERT")).toHaveLength(1);
    // A blanket ALL policy would silently override the narrower ones.
    expect(byCmd("ALL")).toHaveLength(0);
  });

  it.each(["SELECT", "UPDATE", "DELETE"])(
    "restricts %s to the uploader or an admin",
    (cmd) => {
      const policy = byCmd(cmd)[0];
      expect(policy, `missing ${cmd} policy for artist-uploads`).toBeDefined();
      expect(policy!.qual).toContain("bucket_id = 'artist-uploads'::text");
      expect(isOwnerOrAdmin(policy!.qual)).toBe(true);
      // Anonymous visitors must never be able to read or destroy uploads.
      expect(policy!.roles).toContain("authenticated");
      expect(policy!.roles).not.toContain("anon");
      expect(policy!.roles).not.toContain("public");
    },
  );

  it("re-checks ownership on the UPDATE write path", () => {
    const policy = byCmd("UPDATE")[0]!;
    expect(policy.withCheck).not.toBe("");
    expect(isOwnerOrAdmin(policy.withCheck)).toBe(true);
  });

  it("only allows inserts from a signed-in owner of the folder or an admin", () => {
    const policy = byCmd("INSERT")[0]!;
    const expr = policy.withCheck.replace(/\s+/g, " ");
    expect(expr).toContain("bucket_id = 'artist-uploads'::text");
    expect(expr).toContain("(storage.foldername(name))[2] = (auth.uid())::text");
    expect(expr).toContain("private.has_role(auth.uid(), 'admin'::app_role)");
    // Knowing a reference code must never be enough to write into that folder,
    // and anonymous writes are refused outright — guests upload through a
    // server-issued signed URL after their contact email is verified.
    expect(expr).not.toContain("is_track_reference");
    expect(policy.roles).toContain("authenticated");
    expect(policy.roles).not.toContain("anon");
    // No open-ended `true` escape hatch.
    expect(expr).not.toMatch(/with_check\s*true/i);
  });

  it("keeps the helper functions security definer with a pinned search_path", () => {
    const rows = sql(
      `select p.proname, p.prosecdef::text, coalesce(array_to_string(p.proconfig, ','), '')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname in ('has_role', 'track_contact_matches')
        order by p.proname`,
    );
    const names = rows.map((r) => r[0]);
    expect(names).toContain("has_role");
    expect(names).toContain("track_contact_matches");
    for (const [name, secdef, config] of rows) {
      expect(secdef, `${name} must be SECURITY DEFINER`).toBe("true");
      expect(config, `${name} must pin search_path`).toContain("search_path=");
    }
  });

  it("does not expose the artist-uploads bucket publicly", () => {
    const [row] = sql(`select public::text from storage.buckets where id = 'artist-uploads'`);
    expect(row?.[0]).toBe("false");
  });
});
