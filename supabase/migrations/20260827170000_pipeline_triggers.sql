-- Pipeline active DB participation: timestamp + queue audit triggers.
-- Extends Informant event_type for QUEUE_* status transitions.

-- 1. Expand telemetry event_type allow-list for DB-driven audit events.
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
    'CIRCUIT_BREAKER_TRIP'
  ));

-- 2. Automated timestamp trigger function (UTC).
CREATE OR REPLACE FUNCTION public.update_modified_column()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$function$;

-- Prefer a single BEFORE UPDATE timestamp trigger on generation_queue.
DROP TRIGGER IF EXISTS generation_queue_set_updated_at ON public.generation_queue;
DROP TRIGGER IF EXISTS update_generation_queue_mod_time ON public.generation_queue;
CREATE TRIGGER update_generation_queue_mod_time
  BEFORE UPDATE ON public.generation_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.update_modified_column();

-- Keep the older function name as an alias for any external references.
CREATE OR REPLACE FUNCTION public.generation_queue_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$function$;

-- 3. Automated audit / telemetry on job status transitions.
CREATE OR REPLACE FUNCTION public.log_queue_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  event_label text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    event_label := upper('QUEUE_' || NEW.status);

    -- Only insert known Informant event types (guard against unexpected status values).
    IF event_label IN ('QUEUE_PENDING', 'QUEUE_PROCESSING', 'QUEUE_COMPLETED', 'QUEUE_FAILED') THEN
      INSERT INTO public.pipeline_telemetry_logs (
        event_type,
        job_id,
        user_id,
        metadata,
        created_at
      )
      VALUES (
        event_label,
        NEW.id,
        NEW.user_id,
        jsonb_build_object(
          'old_status', OLD.status,
          'new_status', NEW.status,
          'error', NEW.error_message,
          'vault_id', NEW.vault_id,
          'source', 'db_trigger'
        ),
        timezone('utc'::text, now())
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_queue_audit_trail ON public.generation_queue;
CREATE TRIGGER trg_queue_audit_trail
  AFTER UPDATE ON public.generation_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.log_queue_state_change();

COMMENT ON FUNCTION public.log_queue_state_change() IS
  'Writes QUEUE_* Informant rows when generation_queue.status changes.';
