// Prisma CLI config (Prisma 7).
// Prefer DIRECT_URL for migrations when it is a valid Postgres URL;
// otherwise fall back to DATABASE_URL. Runtime clients should use the pooled URL.
import "dotenv/config";
import { defineConfig } from "prisma/config";

function normalizeDatabaseUrl(raw: string | undefined): string {
  let url = (raw ?? "").trim();
  // dotenv / Windows .env layouts can leave surrounding quotes in the value.
  while (
    (url.startsWith('"') && url.endsWith('"')) ||
    (url.startsWith("'") && url.endsWith("'"))
  ) {
    url = url.slice(1, -1).trim();
  }
  // Strip a single leading BOM or zero-width chars if present.
  url = url.replace(/^\uFEFF/, "");
  if (!url) return "";
  if (!/^postgres(ql)?:\/\//i.test(url)) return "";
  if (/[?&]sslmode=/i.test(url)) return url;
  return url.includes("?") ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

function cliDatabaseUrl(): string {
  const direct = normalizeDatabaseUrl(process.env["DIRECT_URL"]);
  if (direct) return direct;
  const pooled = normalizeDatabaseUrl(process.env["DATABASE_URL"]);
  if (pooled) return pooled;
  // Last resort: return empty so Prisma surfaces a clear config error.
  return "";
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
