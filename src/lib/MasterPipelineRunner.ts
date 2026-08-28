// src/lib/MasterPipelineRunner.ts
import { createClient } from "@supabase/supabase-js";
import { ContextFactory } from "@/lib/ExecutionContext";
import { BpmEnlinement } from "@/lib/BpmEnlinement";
import { LogicalRhythmEnlinement } from "@/lib/LogicalRhythmEnlinement";
import { RecordedVoiceStructureEnlinement } from "@/lib/RecordedVoiceStructureEnlinement";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export interface MasterPipelineOptions {
  sessionId: string;
  userId: string;
  genreLock: string;
  masterBpm?: number;
  syncopationThreshold?: number;
}

export class MasterPipelineRunner {
  public static async executePipeline(options: MasterPipelineOptions) {
    const { sessionId, userId, genreLock, masterBpm = 120, syncopationThreshold = 0.42 } = options;

    const ctx = ContextFactory.create(
      userId,
      "enterprise",
      "master-pipeline-runner",
      { sessionNonce: sessionId, requestId: `req_${sessionId}` }
    );

    // Step 1: BPM Enlinement Grid
    const bpmBlueprint = BpmEnlinement.enlineBpmGrid(ctx, {
      masterBpm,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
    });

    // Step 2: Logical Rhythm Enlinement (Wired after BPM)
    const rhythmPatternInput = LogicalRhythmEnlinement.deriveRhythmPatternInput({
      bpmTiming: bpmBlueprint,
      chaosFactor: syncopationThreshold,
    });
    const rhythmBlueprint = LogicalRhythmEnlinement.enlineLogicalRhythm(ctx, rhythmPatternInput);

    // Step 3: Recorded Voice Structure Enlinement (Wired after Rhythm)
    const vocalBlueprint = RecordedVoiceStructureEnlinement.enlineRecordedVocal(ctx, {
      intensity: syncopationThreshold,
    });

    // Update vault ledger with enlinement blueprints & processing status
    const { error } = await supabase
      .from('user_vaults')
      .update({
        status: 'processing',
        metadata: {
          bpmBlueprint,
          rhythmBlueprint,
          vocalBlueprint,
          engine_version: "Hybrid 1.0"
        },
        updated_at: new Date().toISOString()
      })
      .eq('session_id', sessionId);

    if (error) {
      throw new Error(`Failed to update vault ledger state: ${error.message}`);
    }

    return {
      success: true,
      sessionId,
      bpmBlueprint,
      rhythmBlueprint,
      vocalBlueprint,
    };
  }
}
