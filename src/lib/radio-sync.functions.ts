import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const settingsSchema = z.object({
  mixStyle: z.enum(["artist", "genre", "shuffle"]),
  shuffle: z.boolean(),
  spacing: z.number().int().min(1).max(5),
  mixSeed: z.number().int().min(0).max(9999),
  trackKey: z.string().max(300).nullable(),
  queue: z.array(z.string().max(300)).max(500),
  positions: z.record(z.string().max(300), z.number().min(0).max(100000)),
  /** When each resume point was recorded on the sending device (epoch ms). */
  positionTimes: z.record(z.string().max(300), z.number().min(0)).optional(),
  /** Which device recorded each resume point (human label). */
  positionDevices: z.record(z.string().max(300), z.string().max(80)).optional(),


  /** When this device last made an intentional change (ISO timestamp). */
  clientUpdatedAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Invalid datetime")
    .transform((value) => new Date(value).toISOString())
    .optional(),
});

export type SyncedRadioSettings = z.infer<typeof settingsSchema>;

type RadioRow = {
  mix_style: string;
  shuffle: boolean;
  spacing: number;
  mix_seed: number;
  track_key: string | null;
  queue: unknown;
  positions: unknown;
  updated_at: string;
};

/**
 * Stored resume points are either a plain number (legacy) or `{ t, at }` where
 * `at` is when that play/seek happened on the device that recorded it.
 */
const decodePositions = (raw: unknown) => {
  const positions: Record<string, number> = {};
  const positionTimes: Record<string, number> = {};
  const positionDevices: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "number") {
        positions[key] = value;
        positionTimes[key] = 0;
      } else if (value && typeof value === "object") {
        const entry = value as { t?: unknown; at?: unknown; dev?: unknown };
        if (typeof entry.t === "number") {
          positions[key] = entry.t;
          positionTimes[key] = typeof entry.at === "number" ? entry.at : 0;
          if (typeof entry.dev === "string" && entry.dev) positionDevices[key] = entry.dev;
        }
      }
    }
  }
  return { positions, positionTimes, positionDevices };
};

const encodePositions = (
  positions: Record<string, number>,
  times: Record<string, number>,
  devices: Record<string, string>,
) =>
  Object.fromEntries(
    Object.entries(positions).map(([key, t]) => [
      key,
      { t, at: times[key] ?? 0, ...(devices[key] ? { dev: devices[key] } : {}) },
    ]),
  );

const toSettings = (data: RadioRow) => ({
  mixStyle: data.mix_style as SyncedRadioSettings["mixStyle"],

  shuffle: data.shuffle,
  spacing: data.spacing,
  mixSeed: data.mix_seed,
  trackKey: data.track_key,
  queue: Array.isArray(data.queue) ? (data.queue as string[]) : [],
  ...decodePositions(data.positions),
  updatedAt: data.updated_at,
});


const SELECT_COLS = "mix_style, shuffle, spacing, mix_seed, track_key, queue, positions, updated_at";

/** Loads the signed-in listener's saved mix so it restores on any device. */
export const loadRadioSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("radio_settings")
      .select(SELECT_COLS)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return toSettings(data as RadioRow);
  });

/**
 * Saves the current mix, queue order and resume points.
 *
 * Two devices can edit the same account, so writes are last-writer-wins on the
 * listener's own edit timestamp: a save older than what the account already
 * holds is rejected and the newer account state is handed back instead.
 * Resume points always merge, keeping the furthest position per track.
 */
export const saveRadioSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => settingsSchema.parse(input))
  .handler(async ({ data, context }) => {
    const stamp = data.clientUpdatedAt ?? new Date().toISOString();

    const { data: existing, error: readError } = await context.supabase
      .from("radio_settings")
      .select(SELECT_COLS)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);

    const current = existing ? toSettings(existing as RadioRow) : null;

    // Resume points resolve per track on their own timestamps: whichever device
    // recorded the most recent play/seek for that track wins, so an older seek
    // arriving late can never overwrite a newer one.
    const incomingTimes = data.positionTimes ?? {};
    const incomingDevices = data.positionDevices ?? {};
    const mergedPositions: Record<string, number> = { ...(current?.positions ?? {}) };
    const mergedTimes: Record<string, number> = { ...(current?.positionTimes ?? {}) };
    const mergedDevices: Record<string, string> = { ...(current?.positionDevices ?? {}) };
    for (const [key, seconds] of Object.entries(data.positions)) {
      const incomingAt = incomingTimes[key] ?? 0;
      const existingAt = mergedTimes[key] ?? 0;
      if (!(key in mergedPositions) || incomingAt >= existingAt) {
        mergedPositions[key] = seconds;
        mergedTimes[key] = incomingAt;
        if (incomingDevices[key]) mergedDevices[key] = incomingDevices[key];
      }
    }
    const encodedPositions = encodePositions(mergedPositions, mergedTimes, mergedDevices);

    if (current && Date.parse(current.updatedAt) > Date.parse(stamp)) {
      // Another device saved newer mix intent — keep it, but still land the
      // per-track resume points that survived the timestamp comparison.
      await context.supabase
        .from("radio_settings")
        .update({ positions: encodedPositions })
        .eq("user_id", context.userId);
      return {
        ok: false as const,
        conflict: true as const,
        settings: {
          ...current,
          positions: mergedPositions,
          positionTimes: mergedTimes,
          positionDevices: mergedDevices,
        },
      };
    }


    const { error } = await context.supabase.from("radio_settings").upsert(
      {
        user_id: context.userId,
        mix_style: data.mixStyle,
        shuffle: data.shuffle,
        spacing: data.spacing,
        mix_seed: data.mixSeed,
        track_key: data.trackKey,
        queue: data.queue,
        positions: encodedPositions,
        updated_at: stamp,
      },

      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const, conflict: false as const, updatedAt: stamp };
  });

