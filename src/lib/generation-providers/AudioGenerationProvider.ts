/**
 * Abstract contract for every audio generation backend.
 *
 * What needs to be done (generate a track for a user) is separated from how
 * it gets done (which shared API key, model, or future proprietary engine).
 */

export type GenerationRequestPayload = {
  /** Primary style / composition prompt. */
  prompt: string;
  /** Verified auth.users UUID — never an admin/shared fallback. */
  userId: string;
  /**
   * Provider-specific options (lyrics, title, controls, vaultId, full studio
   * payload, supabase client handle, etc.).
   */
  options?: Record<string, unknown>;
};

export type GenerationResult = {
  audioUrl: string;
  durationSeconds?: number;
  providerMetadata?: Record<string, unknown>;
  /** Optional stem URLs when the provider runs the full Hybrid pipeline. */
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  rawAudioUrl?: string | null;
  title?: string;
  style?: string;
  taskId?: string | null;
  vaultId?: string | null;
  /** Full pipeline payload when available (stored on generation_queue.result). */
  rawResult?: Record<string, unknown>;
};

/**
 * Abstract base for all audio generation backends.
 * Throw on failure so the worker circuit / refund path can run.
 */
export abstract class AudioGenerationProvider {
  abstract readonly name: string;

  /**
   * Generates audio for the given payload.
   * Throws if upstream generation fails (worker refunds tokens).
   */
  abstract generateTrack(payload: GenerationRequestPayload): Promise<GenerationResult>;
}
