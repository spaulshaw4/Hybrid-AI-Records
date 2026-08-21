DROP FUNCTION IF EXISTS public.credit_user_tokens(uuid, integer, text);
DROP FUNCTION IF EXISTS public.admin_lookup_token_user(text);

CREATE OR REPLACE FUNCTION public.credit_user_tokens(
  target_user_id uuid,
  token_amount integer,
  reason text DEFAULT NULL,
  acting_admin_id uuid DEFAULT NULL
)
RETURNS TABLE(user_id uuid, balance integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  new_balance integer;
  actor uuid := COALESCE(auth.uid(), acting_admin_id);
BEGIN
  IF actor IS NULL OR NOT EXISTS (
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

CREATE OR REPLACE FUNCTION public.admin_lookup_token_user(
  target_email text,
  acting_admin_id uuid DEFAULT NULL
)
RETURNS TABLE(user_id uuid, email text, balance integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  actor uuid := COALESCE(auth.uid(), acting_admin_id);
BEGIN
  IF actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = actor AND ur.role = 'admin'
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

REVOKE ALL ON FUNCTION public.credit_user_tokens(uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_lookup_token_user(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_user_tokens(uuid, integer, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_lookup_token_user(text, uuid) TO service_role;