import { afterEach, describe, expect, it } from "vitest";
import {
  backendAnonKey,
  backendServiceRoleKey,
  backendSupabaseUrl,
} from "@/lib/supabase-env.server";

const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
] as const;

const original: Record<string, string | undefined> = {};
for (const key of KEYS) original[key] = process.env[key];

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("backend Supabase env", () => {
  it("prefers NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://next.example.supabase.co";
    process.env.SUPABASE_URL = "https://legacy.example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.SUPABASE_SECRET_KEY = "secret-fallback";
    expect(backendSupabaseUrl()).toBe("https://next.example.supabase.co");
    expect(backendServiceRoleKey()).toBe("service-role-test");
  });

  it("falls back to SUPABASE_URL when NEXT_PUBLIC_SUPABASE_URL is unset", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_URL = "https://legacy.example.supabase.co";
    expect(backendSupabaseUrl()).toBe("https://legacy.example.supabase.co");
  });

  it("reads NEXT_PUBLIC_SUPABASE_ANON_KEY for user-scoped clients", () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-next";
    process.env.SUPABASE_ANON_KEY = "anon-legacy";
    expect(backendAnonKey()).toBe("anon-next");
  });
});
