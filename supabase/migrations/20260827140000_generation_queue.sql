-- Async generation queue: multi-tenant shock absorber for shared upstream API keys.
-- Enqueue is fast (token burn + insert); a single worker drains jobs sequentially.

CREATE TABLE IF NOT EXISTS public.generation_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vault_id uuid REFERENCES public.user_vault(id) ON DELETE SET NULL,
  prompt_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  spend_idempotency_key text,
  error_message text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

COMMENT ON TABLE public.generation_queue IS
  'Ordered studio generation jobs. Token burn happens at enqueue; worker drains one-at-a-time against shared upstream keys.';

CREATE INDEX IF NOT EXISTS generation_queue_status_created_idx
  ON public.generation_queue (status, created_at ASC);

CREATE INDEX IF NOT EXISTS generation_queue_user_created_idx
  ON public.generation_queue (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS generation_queue_spend_key_uidx
  ON public.generation_queue (spend_idempotency_key)
  WHERE spend_idempotency_key IS NOT NULL;

GRANT SELECT, INSERT ON public.generation_queue TO authenticated;
GRANT ALL ON public.generation_queue TO service_role;

ALTER TABLE public.generation_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own generation queue jobs"
  ON public.generation_queue;
CREATE POLICY "Users can view their own generation queue jobs"
  ON public.generation_queue
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can enqueue their own generation jobs"
  ON public.generation_queue;
CREATE POLICY "Users can enqueue their own generation jobs"
  ON public.generation_queue
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Atomic claim: one pending row → processing (safe under concurrent workers).
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

CREATE OR REPLACE FUNCTION public.generation_queue_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS generation_queue_set_updated_at ON public.generation_queue;
CREATE TRIGGER generation_queue_set_updated_at
  BEFORE UPDATE ON public.generation_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.generation_queue_set_updated_at();
