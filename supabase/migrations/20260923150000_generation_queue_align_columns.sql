-- Align live generation_queue with app inserts.
-- CREATE TABLE IF NOT EXISTS in 20260827140000 left an older stub untouched,
-- so cortex Gate 2 failed with:
--   Could not find the 'spend_idempotency_key' column of 'generation_queue'

ALTER TABLE public.generation_queue
  ADD COLUMN IF NOT EXISTS vault_id uuid,
  ADD COLUMN IF NOT EXISTS spend_idempotency_key text,
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_node text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_vault'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'generation_queue_vault_id_fkey'
  ) THEN
    ALTER TABLE public.generation_queue
      ADD CONSTRAINT generation_queue_vault_id_fkey
      FOREIGN KEY (vault_id) REFERENCES public.user_vault(id) ON DELETE SET NULL;
  END IF;
END $$;

-- prompt_payload must accept jsonb objects from cortexGate2Enqueue
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'generation_queue'
      AND column_name = 'prompt_payload'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE public.generation_queue
      ALTER COLUMN prompt_payload TYPE jsonb
      USING CASE
        WHEN prompt_payload IS NULL OR btrim(prompt_payload) = '' THEN '{}'::jsonb
        ELSE prompt_payload::jsonb
      END;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS generation_queue_spend_key_uidx
  ON public.generation_queue (spend_idempotency_key)
  WHERE spend_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS generation_queue_status_created_idx
  ON public.generation_queue (status, created_at ASC);

CREATE INDEX IF NOT EXISTS generation_queue_assigned_node_status_idx
  ON public.generation_queue (assigned_node, status)
  WHERE assigned_node IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_generation_queue_job()
RETURNS SETOF public.generation_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  claimed public.generation_queue;
BEGIN
  SELECT q.*
    INTO claimed
    FROM public.generation_queue q
   WHERE q.status = 'pending'
   ORDER BY q.created_at ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.generation_queue q
     SET status = 'processing',
         started_at = now(),
         updated_at = now()
   WHERE q.id = claimed.id
   RETURNING q.* INTO claimed;

  RETURN NEXT claimed;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_generation_queue_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_generation_queue_job() TO service_role;
GRANT ALL ON public.generation_queue TO service_role;

NOTIFY pgrst, 'reload schema';
