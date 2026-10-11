/**
 * Clearance tier for a finished vaulted_tracks row, plus the one-time letter.
 * A missing column or a missing mailbox must not discard the stored master.
 */
import { vaultAdminClient } from "@/lib/vault-admin.server";
import {
  sendCommercialClearanceEmail,
  type ClearanceTier,
} from "@/lib/clearance-email.server";

export type { ClearanceTier };
export type LyricsOrigin = "user" | "synthetic";

export function readLyricsOrigin(value: unknown): LyricsOrigin | null {
  if (value === "user" || value === "synthetic") return value;
  return null;
}

export function resolveClearanceTier(input: {
  instrumental: boolean;
  lyrics?: string | null;
  lyricsOrigin?: LyricsOrigin | null;
  vocalId?: string | null;
  humanVocal?: boolean;
}): ClearanceTier {
  if (input.instrumental) return "instrumental";
  const humanStem = input.humanVocal === true || Boolean(input.vocalId?.trim());
  if (humanStem) return "verified_vocal";
  const lyrics = (input.lyrics ?? "").trim();
  if (input.lyricsOrigin === "synthetic" || !lyrics) return "ai_voice";
  return "verified_vocal";
}

async function stampClearanceTier(input: {
  userId: string;
  taskId: string;
  title: string;
  tier: ClearanceTier;
}): Promise<void> {
  const userId = input.userId.trim();
  const taskId = input.taskId.trim();
  const title = input.title.trim();
  if (!userId || !taskId || !title) return;
  try {
    const supabase = vaultAdminClient();
    const updated = await supabase
      .from("vaulted_tracks")
      .update({ clearance_tier: input.tier })
      .eq("user_id", userId)
      .eq("task_id", taskId)
      .eq("title", title);
    if (updated.error) {
      console.error("[clearance] clearance_tier column update failed");
    }
  } catch {
    console.error("[clearance] clearance_tier column update failed");
  }
}

async function resolveSessionRecipient(userId: string): Promise<{ email: string | null; name: string }> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    const emailRaw = data?.user?.email?.trim() ?? "";
    const email = emailRaw.includes("@") ? emailRaw : null;
    const meta = (data?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const fromMeta =
      (typeof meta.display_name === "string" && meta.display_name.trim()) ||
      (typeof meta.full_name === "string" && meta.full_name.trim()) ||
      (typeof meta.name === "string" && meta.name.trim()) ||
      "";
    let name = "";
    try {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("display_name")
        .eq("user_id", userId)
        .maybeSingle();
      const display = typeof profile?.display_name === "string" ? profile.display_name.trim() : "";
      if (display) name = display;
    } catch {
      name = "";
    }
    if (!name) name = fromMeta;
    return { email, name: name || "Creator" };
  } catch {
    console.error("[clearance] recipient lookup failed");
    return { email: null, name: "Creator" };
  }
}

/**
 * Writes clearance_tier on the vault row and emails the session user once.
 * masterId is the vaulted_tracks id when the caller has it, otherwise the stored task id.
 */
export async function finalizeTrackClearance(input: {
  userId: string;
  taskId: string;
  title: string;
  lyrics?: string | null;
  instrumental: boolean;
  lyricsOrigin?: LyricsOrigin | null;
  vocalId?: string | null;
  humanVocal?: boolean;
  isrc?: string | null;
  createdAt?: Date;
  masterId?: string | null;
  trackKey?: string | null;
  to?: string | null;
  artistName?: string | null;
}): Promise<{ tier: ClearanceTier; emailed: boolean }> {
  const tier = resolveClearanceTier({
    instrumental: input.instrumental,
    lyrics: input.lyrics,
    lyricsOrigin: input.lyricsOrigin,
    vocalId: input.vocalId,
    humanVocal: input.humanVocal,
  });
  const taskId = input.taskId.trim();
  const title = input.title.trim();
  await stampClearanceTier({
    userId: input.userId,
    taskId,
    title,
    tier,
  });

  const masterId = input.masterId?.trim() || taskId;
  const trackKey = input.trackKey?.trim() || masterId;
  if (!masterId || !trackKey) return { tier, emailed: false };

  let to = input.to?.trim() ?? "";
  let artistName = input.artistName?.trim() ?? "";
  if (!to || !artistName) {
    const resolved = await resolveSessionRecipient(input.userId);
    if (!to) to = resolved.email ?? "";
    if (!artistName) artistName = resolved.name;
  }
  if (!artistName) artistName = "Creator";
  if (!to) {
    console.warn("[clearance] no recipient");
    return { tier, emailed: false };
  }

  const sent = await sendCommercialClearanceEmail({
    to,
    tier,
    trackTitle: title,
    masterId,
    isrc: input.isrc,
    createdAt: input.createdAt ?? new Date(),
    artistName,
    trackId: trackKey,
  });
  return { tier, emailed: sent.ok };
}
