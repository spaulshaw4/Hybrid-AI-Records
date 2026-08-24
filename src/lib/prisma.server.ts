import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Track } from "@/generated/prisma/client";

let _prisma: PrismaClient | null = null;
let _pool: Pool | null = null;

function normalizeDatabaseUrl(raw: string | undefined): string {
  let url = (raw ?? "").trim();
  while (
    (url.startsWith('"') && url.endsWith('"')) ||
    (url.startsWith("'") && url.endsWith("'"))
  ) {
    url = url.slice(1, -1).trim();
  }
  if (!url) return "";
  // Prefer libpq-compat require so pg does not force verify-full.
  if (!/[?&]sslmode=/i.test(url)) {
    url = url.includes("?") ? `${url}&sslmode=require` : `${url}?sslmode=require`;
  }
  if (!/[?&]uselibpqcompat=/i.test(url)) {
    url = `${url}&uselibpqcompat=true`;
  }
  return url;
}

/** Lazy Prisma client — pooled DATABASE_URL via PrismaPg (Prisma 7). */
export function getPrisma(): PrismaClient {
  if (_prisma) return _prisma;
  const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);
  if (!connectionString) {
    throw new Error("Missing DATABASE_URL for Prisma client");
  }
  _pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
  const adapter = new PrismaPg(_pool);
  _prisma = new PrismaClient({ adapter });
  return _prisma;
}

/** @deprecated Prefer getPrisma() — kept for call sites that import `prisma`. */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getPrisma(), prop, receiver);
  },
});

export type UpsertPipelineTrackInput = {
  id: string;
  title: string;
  prompt: string;
  status?: string;
  gateMask?: number;
  rawAudioUrl?: string | null;
  stemsUrl?: string | null;
  masterUrl?: string | null;
  errorMessage?: string | null;
};

/** Create or refresh a Track row when Gate 1 / pipeline starts. */
export async function upsertPipelineTrack(input: UpsertPipelineTrackInput): Promise<Track> {
  const client = getPrisma();
  return client.track.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      title: input.title,
      prompt: input.prompt,
      status: input.status ?? "QUEUED",
      gateMask: input.gateMask ?? 0,
      rawAudioUrl: input.rawAudioUrl ?? null,
      stemsUrl: input.stemsUrl ?? null,
      masterUrl: input.masterUrl ?? null,
      errorMessage: input.errorMessage ?? null,
    },
    update: {
      title: input.title,
      prompt: input.prompt,
      status: input.status ?? "PROCESSING",
      gateMask: input.gateMask,
      rawAudioUrl: input.rawAudioUrl === undefined ? undefined : input.rawAudioUrl,
      stemsUrl: input.stemsUrl === undefined ? undefined : input.stemsUrl,
      masterUrl: input.masterUrl === undefined ? undefined : input.masterUrl,
      errorMessage: input.errorMessage === undefined ? undefined : input.errorMessage,
    },
  });
}

export async function patchPipelineTrack(
  id: string,
  data: Partial<{
    status: string;
    gateMask: number;
    rawAudioUrl: string | null;
    stemsUrl: string | null;
    masterUrl: string | null;
    errorMessage: string | null;
  }>,
): Promise<Track | null> {
  try {
    return await getPrisma().track.update({ where: { id }, data });
  } catch {
    return null;
  }
}
