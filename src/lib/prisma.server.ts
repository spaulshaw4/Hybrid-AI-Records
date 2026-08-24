import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("Missing DATABASE_URL for Prisma client");
}

const adapter = new PrismaPg({ connectionString });

/** Server-only Prisma client (pooled DATABASE_URL via PrismaPg adapter). */
export const prisma = new PrismaClient({ adapter });
