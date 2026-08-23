/**
 * Gate 2 — Supabase vault isolation.
 *
 * Uploads the Gate 1 raw audio buffer to the audio-vault bucket, returns a
 * verified public HTTPS CDN URL, and never hands localhost paths to Replicate.
 * Does not alter database column schemas.
 */

import { AUDIO_VAULT_BUCKET } from "@/lib/audio-vault";
import { requireSupabaseAdmin } from "@/integrations/supabase/client.server";
import { isPublicHttpAudioUrl } from "@/lib/pipeline-contracts";
import { GATE_TIMEOUTS_MS, withTimeout } from "@/lib/pipeline-gate.server";

export type Gate2VaultResult = {
  /** HTTPS URL safe for Replicate CWALO / Demucs. */
  publicAudioUrl: string;
  /** Object key in the vault bucket. */
  rawPath: string;
};

function rawObjectPath(trackId: string): string {
  const id = trackId.replace(/[^a-zA-Z0-9_-]/g, "_") || "track";
  return `raw/${id}.mp3`;
}

/**
 * Upload raw Gate 1 bytes → vault → public CDN URL (circuit: 30s).
 */
export async function runGate2SupabaseVault(input: {
  rawAudioBuffer: Uint8Array;
  trackId: string;
}): Promise<Gate2VaultResult> {
  console.log("[Gate 2/6] Supabase Vault Upload...");
  if (!input.rawAudioBuffer?.byteLength) {
    throw new Error("[Circuit Breaker] Gate 2 failed: Empty audio buffer for vault upload.");
  }

  const rawPath = rawObjectPath(input.trackId);
  const supabaseAdmin = requireSupabaseAdmin();

  await withTimeout(
    (async () => {
      try {
        const { error } = await supabaseAdmin.storage
          .from(AUDIO_VAULT_BUCKET)
          .upload(rawPath, input.rawAudioBuffer, {
            /** Gate 2 raw tracks are always MPEG. */
            contentType: "audio/mpeg",
            upsert: true,
            cacheControl: "31536000",
          });
        if (error) {
          console.error("[Gate 2 Error] Supabase vault upload failed:", error.message, error);
          throw new Error(`[Circuit Breaker] Gate 2 upload failed: ${error.message}`);
        }
      } catch (uploadErr) {
        if (uploadErr instanceof Error && /Gate 2/.test(uploadErr.message)) {
          throw uploadErr;
        }
        console.error("[Gate 2 Error] Unexpected vault upload failure:", uploadErr);
        throw new Error(
          `[Circuit Breaker] Gate 2 upload failed: ${
            uploadErr instanceof Error ? uploadErr.message : String(uploadErr)
          }`,
        );
      }
    })(),
    GATE_TIMEOUTS_MS[2],
    "Gate 2 (Supabase Upload)",
  );

  const {
    data: { publicUrl: publicAudioUrl },
  } = supabaseAdmin.storage.from(AUDIO_VAULT_BUCKET).getPublicUrl(rawPath);

  if (!publicAudioUrl || !publicAudioUrl.startsWith("http") || !isPublicHttpAudioUrl(publicAudioUrl)) {
    throw new Error(
      "[Circuit Breaker] Gate 2 failed: Invalid public HTTPS CDN URL generated.",
    );
  }

  console.log(`[Gate 2/6] Finished — public=${publicAudioUrl.slice(0, 96)}`);
  return { publicAudioUrl, rawPath };
}

/**
 * Gate 6 final commit — upload master buffer → vault → public URL (circuit: 30s).
 */
export async function commitMasterToVault(input: {
  masterBuffer: Uint8Array;
  trackId: string;
  contentType?: string;
}): Promise<string> {
  const id = input.trackId.replace(/[^a-zA-Z0-9_-]/g, "_") || "track";
  const masterPath = `masters/${id}_master.wav`;
  const supabaseAdmin = requireSupabaseAdmin();

  const contentType = "audio/wav";
  await withTimeout(
    (async () => {
      try {
        const { error } = await supabaseAdmin.storage
          .from(AUDIO_VAULT_BUCKET)
          .upload(masterPath, input.masterBuffer, {
            /** Gate 6 masters are always WAV at the vault boundary. */
            contentType,
            upsert: true,
            cacheControl: "31536000",
          });
        if (error) {
          console.error("[Gate 6 Error] Supabase master vault upload failed:", error.message, error);
          throw new Error(`[Circuit Breaker] Gate 6 final commit failed: ${error.message}`);
        }
      } catch (uploadErr) {
        if (uploadErr instanceof Error && /Gate 6/.test(uploadErr.message)) {
          throw uploadErr;
        }
        console.error("[Gate 6 Error] Unexpected master vault upload failure:", uploadErr);
        throw new Error(
          `[Circuit Breaker] Gate 6 final commit failed: ${
            uploadErr instanceof Error ? uploadErr.message : String(uploadErr)
          }`,
        );
      }
    })(),
    GATE_TIMEOUTS_MS[6],
    "Gate 6 (Supabase Final Commit)",
  );

  const {
    data: { publicUrl: finalMasterUrl },
  } = supabaseAdmin.storage.from(AUDIO_VAULT_BUCKET).getPublicUrl(masterPath);

  if (!finalMasterUrl || !finalMasterUrl.startsWith("http") || !isPublicHttpAudioUrl(finalMasterUrl)) {
    throw new Error(
      "[Circuit Breaker] Gate 6 failed: Invalid public HTTPS master URL generated.",
    );
  }
  return finalMasterUrl;
}
