-- Alias: generation_jobs → generation_queue (cloud-native worker vocabulary).
-- Ingress inserts pending rows; the isolated worker drains them sequentially.

CREATE OR REPLACE VIEW public.generation_jobs AS
SELECT
  id,
  user_id,
  vault_id,
  prompt_payload,
  status,
  spend_idempotency_key,
  error_message,
  result,
  created_at,
  updated_at,
  started_at,
  completed_at
FROM public.generation_queue;

COMMENT ON VIEW public.generation_jobs IS
  'Alias of generation_queue for cloud-native worker docs/clients.';

GRANT SELECT ON public.generation_jobs TO authenticated;
GRANT ALL ON public.generation_jobs TO service_role;
