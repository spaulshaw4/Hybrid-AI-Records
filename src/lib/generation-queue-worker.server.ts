// src/lib/generation-queue-worker.server.ts
import { createClient } from "@supabase/supabase-js";
import { MasterPipelineRunner } from "@/lib/MasterPipelineRunner";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Missing Supabase environment credentials for background worker.");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const POLL_INTERVAL_MS = 5000;

export class GenerationQueueWorker {
  private isRunning: boolean = false;

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("[WORKER] Generation queue worker started.");
    this.pollLoop();
  }

  public stop() {
    this.isRunning = false;
    console.log("[WORKER] Generation queue worker stopped.");
  }

  private async pollLoop() {
    while (this.isRunning) {
      try {
        await this.processNextJob();
      } catch (err) {
        console.error("[WORKER ERROR] Exception in poll cycle:", err);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private async processNextJob() {
    const { data: jobs, error: fetchError } = await supabase
      .from("user_vaults")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1);

    if (fetchError) {
      console.error("[WORKER] Failed to fetch pending session:", fetchError.message);
      return;
    }

    if (!jobs || jobs.length === 0) {
      return;
    }

    const job = jobs[0];
    const sessionId = job.session_id;
    const userId = job.user_id || "system_user";
    const genreLock = job.genre_lock || "heavy_alternative_rock";

    console.log(`[WORKER] Processing session ${sessionId} with genre lock: ${genreLock}`);

    try {
      await MasterPipelineRunner.executePipeline({
        sessionId,
        userId,
        genreLock,
      });

      console.log(`[WORKER] Successfully completed pipeline enlinement for session ${sessionId}`);
    } catch (err: any) {
      console.error(`[WORKER] Pipeline execution failed for session ${sessionId}:`, err.message);

      await supabase
        .from("user_vaults")
        .update({
          status: "failed",
          metadata: {
            error_message: err.message,
            failed_at: new Date().toISOString(),
          },
        })
        .eq("session_id", sessionId);
    }
  }
}

// Singleton worker instance for server runtime
export const queueWorker = new GenerationQueueWorker();
