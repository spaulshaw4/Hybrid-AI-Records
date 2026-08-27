-- Deep Isolation Placement: assigned_node routing + Informant event type.

ALTER TABLE public.generation_queue
  ADD COLUMN IF NOT EXISTS assigned_node text;

COMMENT ON COLUMN public.generation_queue.assigned_node IS
  'Logical worker cluster node assigned by DeepIsolationPlacement (e.g. standard-worker-grid-pool).';

CREATE INDEX IF NOT EXISTS generation_queue_assigned_node_status_idx
  ON public.generation_queue (assigned_node, status)
  WHERE assigned_node IS NOT NULL;

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
    'DEEP_ISOLATION_PLACEMENT'
  ));
