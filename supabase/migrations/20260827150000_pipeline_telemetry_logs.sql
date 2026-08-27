-- Pipeline Informant audit trail: queue, worker, token, and delivery telemetry.
-- Writes are service_role only; Informant failures must never block generation.

CREATE TABLE IF NOT EXISTS public.pipeline_telemetry_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL
    CHECK (event_type IN (
      'QUEUE_ENQUEUE',
      'WORKER_START',
      'GENERATION_SUCCESS',
      'GENERATION_FAILURE',
      'TOKEN_REFUND',
      'ACTUATOR_FLUSH',
      'ACTUATOR_HEALTH'
    )),
  job_id uuid,
  user_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pipeline_telemetry_logs IS
  'Structured Informant telemetry for Cortex queue, worker, End-Gate, and Actuator actions.';

CREATE INDEX IF NOT EXISTS pipeline_telemetry_logs_created_idx
  ON public.pipeline_telemetry_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS pipeline_telemetry_logs_event_created_idx
  ON public.pipeline_telemetry_logs (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS pipeline_telemetry_logs_user_created_idx
  ON public.pipeline_telemetry_logs (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pipeline_telemetry_logs_job_idx
  ON public.pipeline_telemetry_logs (job_id)
  WHERE job_id IS NOT NULL;

ALTER TABLE public.pipeline_telemetry_logs ENABLE ROW LEVEL SECURITY;

-- No authenticated policies: telemetry is service_role / staff-only.
REVOKE ALL ON public.pipeline_telemetry_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pipeline_telemetry_logs TO service_role;
