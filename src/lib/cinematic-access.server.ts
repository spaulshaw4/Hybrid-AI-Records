/**
 * Access guard for the paid Visual Engine pipeline.
 *
 * Every Visual Engine server route (script writing, style tuning, concept
 * boards, scene generation, renders) runs strictly on `GOOGLE_PAID_API_KEY`.
 * Nothing may dispatch against that key unless the caller holds Video Tokens.
 * Engine 1.0 (free) routes never call this.
 */
import { assertPaidAiKey } from "@/lib/ai-provider.server";

export async function requireCinematicAccess(_userId: string): Promise<void> {
  // Text work (scripts, scene breakdowns, style tuning, character assistants)
  // only needs the paid key — Video Tokens are verified and deducted solely by
  // the actual video render endpoints via `requireVideoTokens`.
  assertPaidAiKey("Visual Engine");
}
