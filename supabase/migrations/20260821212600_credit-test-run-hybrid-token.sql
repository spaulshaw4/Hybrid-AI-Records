-- One Hybrid Token for a local Matchering pipeline test run.
-- Idempotent: re-applying this migration does not double-credit.

DO $$
DECLARE
  v_user_id uuid := '0369f3ad-2a9b-4ed4-94dc-9d9cad7bb7c2';
  v_idempotency text := 'test-run-matchering-2026-08-21-1';
BEGIN
  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;

  PERFORM public.credit_user_tokens(
    v_user_id,
    1,
    'Test run credit — Matchering 2.0 pipeline',
    v_user_id,
    v_idempotency
  );
END;
$$;
