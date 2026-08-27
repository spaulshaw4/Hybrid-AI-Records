import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("studio request-scoped auth (zero-trust)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns the verified session user id when Bearer is present", async () => {
    const userId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    vi.doMock("@/lib/supabase-env.server", () => ({
      backendAnonKey: () => "sb_publishable_test",
      backendSupabaseUrl: () => "https://example.supabase.co",
    }));
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: userId } }, error: null }),
        },
      }),
    }));

    const { studioUserIdFromRequestOrDev } = await import("@/lib/studio-request-auth.server");
    const request = new Request("https://example.test/api/studio/generate-stream", {
      headers: { Authorization: "Bearer aaa.bbb.ccc" },
    });
    await expect(studioUserIdFromRequestOrDev(request)).resolves.toBe(userId);
  });

  it("does not remap a failed Bearer session onto any shared/dev UUID", async () => {
    vi.doMock("@/lib/supabase-env.server", () => ({
      backendAnonKey: () => "sb_publishable_test",
      backendSupabaseUrl: () => "https://example.supabase.co",
    }));
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        auth: {
          getUser: async () => ({ data: { user: null }, error: { message: "invalid" } }),
        },
      }),
    }));
    vi.doMock("@/lib/dev-auth", () => ({
      DEV_TEST_USER_UUID: "11111111-1111-4111-8111-111111111111",
      isDevAuthBypass: () => true,
    }));

    const { studioUserIdFromRequestOrDev } = await import("@/lib/studio-request-auth.server");
    const request = new Request("https://example.test/api/studio/generate-stream", {
      headers: { Authorization: "Bearer aaa.bbb.ccc" },
    });
    await expect(studioUserIdFromRequestOrDev(request)).resolves.toBeNull();
  });

  it("returns null with no JWT even when local DEV bypass flag is on", async () => {
    vi.doMock("@/lib/dev-auth", () => ({
      DEV_TEST_USER_UUID: "11111111-1111-4111-8111-111111111111",
      isDevAuthBypass: () => true,
    }));

    const { studioUserIdFromRequestOrDev, resolveStudioSessionOrDev } = await import(
      "@/lib/studio-request-auth.server"
    );
    const request = new Request("https://example.test/api/studio/generate-stream");
    await expect(studioUserIdFromRequestOrDev(request)).resolves.toBeNull();
    await expect(resolveStudioSessionOrDev(request)).resolves.toBeNull();
  });

  it("resolves session user id from sb-access-token cookie when Bearer is absent", async () => {
    const userId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    vi.doMock("@/lib/supabase-env.server", () => ({
      backendAnonKey: () => "sb_publishable_test",
      backendSupabaseUrl: () => "https://example.supabase.co",
    }));
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: userId } }, error: null }),
        },
      }),
    }));

    const { studioUserIdFromRequestOrDev } = await import("@/lib/studio-request-auth.server");
    const request = new Request("https://example.test/api/studio/generate-stream", {
      headers: { Cookie: "sb-access-token=aaa.bbb.ccc" },
    });
    await expect(studioUserIdFromRequestOrDev(request)).resolves.toBe(userId);
  });

  it("throws UnauthorizedSessionError with status 401", async () => {
    const { resolveStudioSession, UnauthorizedSessionError } = await import(
      "@/lib/studio-request-auth.server"
    );
    const request = new Request("https://example.test/api/studio/generate-stream");
    await expect(resolveStudioSession(request)).rejects.toBeInstanceOf(UnauthorizedSessionError);
    try {
      await resolveStudioSession(request);
    } catch (error) {
      expect(error).toMatchObject({ status: 401, statusCode: 401 });
    }
  });
});

describe("multi-tenant pipeline contracts", () => {
  it("auth middleware has no DEV UUID identity injection", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/integrations/supabase/auth-middleware.ts"),
      "utf8",
    );
    expect(source).toContain("resolveStudioSession");
    expect(source).not.toContain("DEV_TEST_USER_UUID");
    expect(source).not.toContain("isDevAuthBypass");
    expect(source).not.toContain("tryGetSupabaseAdmin");
  });

  it("generate-stream ingress goes through cortex (auth + burn + enqueue)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/routes/api/studio/generate-stream.ts"),
      "utf8",
    );
    expect(source).toContain("executeGenerationCortex");
    expect(source).toContain("cortexErrorResponse");
    expect(source).toContain("status: 202");
    expect(source).not.toContain("resolveStudioSessionOrDev");
    expect(source).not.toContain("DEV_TEST_USER_UUID");
  });

  it("final vault persist rethrows so tokens refund after a failed insert", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/lib/apiframe-music.functions.ts"),
      "utf8",
    );
    expect(source).toContain("Vault insert failed for user:");
    expect(source).toContain("await refundGenerationToken");
    expect(source).toContain("persistUserVault(db, context.userId");
  });

  it("spend_hybrid_tokens locks the caller balance row (FOR UPDATE)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20260826220000_fix_spend_hybrid_tokens_balance_shadow.sql"),
      "utf8",
    );
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/tb\.balance >= _amount/);
    expect(sql).toMatch(/WHERE tb\.user_id = _user_id/);
  });
});
