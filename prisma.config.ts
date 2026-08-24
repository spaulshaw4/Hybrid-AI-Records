// Prisma CLI config (Prisma 7).
// Prefer DIRECT_URL for migrations (session/direct); fall back to DATABASE_URL.
// Runtime PrismaClient should still use the pooled DATABASE_URL.
import "dotenv/config";
import { defineConfig } from "prisma/config";

function cliDatabaseUrl(): string {
  const raw = process.env["DIRECT_URL"] || process.env["DATABASE_URL"] || "";
  if (!raw) return raw;
  // Supabase (and most cloud Postgres) require TLS; Prisma reports P1001 without it.
  if (/[?&]sslmode=/i.test(raw)) return raw;
  return raw.includes("?") ? `${raw}&sslmode=require` : `${raw}?sslmode=require`;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: cliDatabaseUrl(),
  },
});
