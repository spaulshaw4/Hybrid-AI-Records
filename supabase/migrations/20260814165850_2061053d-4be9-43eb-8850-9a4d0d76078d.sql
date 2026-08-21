CREATE TABLE public.token_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_id uuid,
  token_amount integer NOT NULL,
  reason text,
  balance_after integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.token_audit_log TO authenticated;
GRANT ALL ON public.token_audit_log TO service_role;

ALTER TABLE public.token_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view token audit log"
  ON public.token_audit_log FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
  ));

CREATE INDEX token_audit_log_user_id_created_at_idx
  ON public.token_audit_log (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.credit_user_tokens(
  target_user_id uuid,
  token_amount integer,
  reason text DEFAULT NULL
)
RETURNS TABLE(user_id uuid, balance integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  new_balance integer;
  actor uuid := auth.uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = actor AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF token_amount IS NULL OR token_amount <= 0 OR token_amount > 100 THEN
    RAISE EXCEPTION 'invalid token amount';
  END IF;

  INSERT INTO public.token_balances (user_id, balance)
  VALUES (target_user_id, token_amount)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.token_balances.balance + EXCLUDED.balance,
        updated_at = now()
  RETURNING public.token_balances.balance INTO new_balance;

  INSERT INTO public.token_audit_log (user_id, admin_id, token_amount, reason, balance_after)
  VALUES (target_user_id, actor, token_amount, reason, new_balance);

  INSERT INTO public.token_ledger (user_id, delta, kind, reference, note, balance_after)
  VALUES (target_user_id, token_amount, 'admin_credit', NULL, reason, new_balance);

  RETURN QUERY SELECT target_user_id, new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_lookup_token_user(target_email text)
RETURNS TABLE(user_id uuid, email text, balance integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT u.id, u.email::text, COALESCE(tb.balance, 0)
  FROM auth.users u
  LEFT JOIN public.token_balances tb ON tb.user_id = u.id
  WHERE lower(u.email) = lower(trim(target_email))
  LIMIT 1;
END;
$$;