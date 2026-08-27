-- Reactive Corement Placement: Informant event type for routing audit.

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
    'CONSEQUENCE_FAILURE_ADAPTATION',
    'REACTIVE_PLACEMENT_ROUTING'
  ));
