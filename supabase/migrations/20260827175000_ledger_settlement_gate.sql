-- Ledger Settlement Gate: Informant event for vault/token audit seal.

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
    'REACTIVE_PLACEMENT_ROUTING',
    'DEEP_ISOLATION_PLACEMENT',
    'ISOLATED_GROUND_DRAIN_TRIGGERED',
    'LEDGER_SETTLEMENT_COMMITTED'
  ));
