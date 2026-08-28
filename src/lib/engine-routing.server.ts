// src/lib/engine-routing.server.ts
import { createClient } from "@supabase/supabase-js";
import { buildInHousePayload } from "./inhouse-payload";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function dispatchInHouseJob(userId: string, sessionId: string, genreLock: string, prompt: string, lyrics?: string) {
  const payload = buildInHousePayload(genreLock, prompt, lyrics);
  console.log(`[Engine Routing] Routing session ${sessionId} to in-house Cylinder Orchestrator...`);

  try {
    // Execute atomic token deduction and vault creation in one network call
    const { data, error } = await supabase.rpc('spend_hybrid_token_and_create_session', {
      p_user_id: userId,
      p_session_id: sessionId,
      p_genre_lock: genreLock,
      p_metadata: payload
    });

    if (error || !data) {
      throw new Error(`Token deduction failed or insufficient funds: ${error?.message}`);
    }

    console.log(`[Engine Routing SUCCESS] Job ${sessionId} queued in Supabase vault for local daemon.`);

    // Return success to the UI; the local Python daemon will take over from here.
    return { success: true, sessionId, status: 'pending' };
  } catch (error) {
    console.error(`[Engine Routing ERROR] Failed to queue job ${sessionId}:`, error);
    return { success: false, error };
  }
}
