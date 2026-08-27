-- Consequence behavior: throttle multiplier config + Informant event types.

ALTER TABLE public.pipeline_telemetry_logs
  DROP CONSTRAINT IF EXISTS pipeline_telemetry_logs_event_type_check;

ALTER TABLE public.pipeline_telemetry_logs
  ADD CONSTRAINT pipeline_telemetry_logs_event_type_check
  CHECK (event_type IN (
    'QUEUE_ENQUEUE',
    'WORKER_START',
    'GENERATION_SUCCESS',
    'GENERATION_FAILURE',
    'TOKEN_REFUND',
    'ACTUATOR_FLUSH',
    'ACTUATOR_HEALTH',
    'QUEUE_PENDING',
    'QUEUE_PROCESSING',
    'QUEUE_COMPLETED',
    'QUEUE_FAILED',
    'CIRCUIT_BREAKER_TRIP',
    'CONSEQUENCE_FAILURE_ADAPTATION'
  ));

INSERT INTO public.system_config (key, value, updated_by)
VALUES ('behavioral_throttle_multiplier', '1.0', 'migration')
ON CONFLICT (key) DO NOTHING;
