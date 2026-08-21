CREATE OR REPLACE FUNCTION public.credit_user_tokens(
  target_user_id uuid,
  token_amount integer,
  reason text DEFAULT NULL::text,
  acting_admin_id uuid DEFAULT NULL::uuid,
  idempotency_key text DEFAULT NULL::text
)
RETURNS TABLE(user_id uuid, balance integer, already_applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_balance integer;
  actor uuid := COALESCE(auth.uid(), acting_admin_id);
  idem text := NULLIF(btrim(idempotency_key), '');
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

  IF idem IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.token_ledger tl WHERE tl.idempotency_key = idem
  ) THEN
    SELECT COALESCE(tb.balance, 0) INTO new_balance
    FROM public.token_balances tb WHERE tb.user_id = target_user_id;
    RETURN QUERY SELECT target_user_id, COALESCE(new_balance, 0), true;
    RETURN;
  END IF;

  INSERT INTO public.token_balances (user_id, balance)
  VALUES (target_user_id, token_amount)
  ON CONFLICT ON CONSTRAINT token_balances_pkey DO UPDATE
    SET balance = public.token_balances.balance + EXCLUDED.balance,
        updated_at = now()
  RETURNING public.token_balances.balance INTO new_balance;

  INSERT INTO public.token_audit_log (user_id, admin_id, token_amount, reason, balance_after)
  VALUES (target_user_id, actor, token_amount, reason, new_balance);

  INSERT INTO public.token_ledger (user_id, delta, kind, reference, note, balance_after, idempotency_key)
  VALUES (target_user_id, token_amount, 'admin_credit', NULL, reason, new_balance, idem);

  RETURN QUERY SELECT target_user_id, new_balance, false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_user_tokens(
  target_user_id uuid,
  token_amount integer,
  reason text DEFAULT NULL::text,
  reference text DEFAULT NULL::text,
  acting_admin_id uuid DEFAULT NULL::uuid,
  idempotency_key text DEFAULT NULL::text
)
RETURNS TABLE(user_id uuid, balance integer, already_applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_balance integer;
  actor uuid := COALESCE(auth.uid(), acting_admin_id);
  refund_reason text := COALESCE(NULLIF(btrim(reason), ''), 'Refund for failed generation');
  idem text := NULLIF(btrim(idempotency_key), '');
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

  IF idem IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.token_ledger tl WHERE tl.idempotency_key = idem
  ) THEN
    SELECT COALESCE(tb.balance, 0) INTO new_balance
    FROM public.token_balances tb WHERE tb.user_id = target_user_id;
    RETURN QUERY SELECT target_user_id, COALESCE(new_balance, 0), true;
    RETURN;
  END IF;

  INSERT INTO public.token_balances (user_id, balance)
  VALUES (target_user_id, token_amount)
  ON CONFLICT ON CONSTRAINT token_balances_pkey DO UPDATE
    SET balance = public.token_balances.balance + EXCLUDED.balance,
        updated_at = now()
  RETURNING public.token_balances.balance INTO new_balance;

  INSERT INTO public.token_audit_log (user_id, admin_id, token_amount, reason, balance_after)
  VALUES (target_user_id, actor, token_amount, 'Refund: ' || refund_reason, new_balance);

  INSERT INTO public.token_ledger (user_id, delta, kind, reference, note, balance_after, idempotency_key)
  VALUES (target_user_id, token_amount, 'refund', reference, refund_reason, new_balance, idem);

  RETURN QUERY SELECT target_user_id, new_balance, false;
END;
$function$;

REVOKE ALL ON FUNCTION public.credit_user_tokens(uuid, integer, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_user_tokens(uuid, integer, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_user_tokens(uuid, integer, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_user_tokens(uuid, integer, text, text, uuid, text) TO service_role;

DO $$
DECLARE
  v_user_id uuid := '0369f3ad-2a9b-4ed4-94dc-9d9cad7bb7c2';
  v_idempotency text := 'manual-credit-2026-08-14-spaulshaw4-10';
BEGIN
  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;

  PERFORM public.credit_user_tokens(
    v_user_id,
    10,
    'Manual admin credit — 10 Hybrid Tokens',
    v_user_id,
    v_idempotency
  );
END;
$$;