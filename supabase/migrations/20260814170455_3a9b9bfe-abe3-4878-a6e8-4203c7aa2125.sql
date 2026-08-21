CREATE OR REPLACE FUNCTION public.refund_user_tokens(target_user_id uuid, token_amount integer, reason text DEFAULT NULL::text, reference text DEFAULT NULL::text, acting_admin_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(user_id uuid, balance integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_balance integer;
  actor uuid := COALESCE(auth.uid(), acting_admin_id);
  refund_reason text := COALESCE(NULLIF(btrim(reason), ''), 'Refund for failed generation');
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
  VALUES (target_user_id, actor, token_amount, 'Refund: ' || refund_reason, new_balance);

  INSERT INTO public.token_ledger (user_id, delta, kind, reference, note, balance_after)
  VALUES (target_user_id, token_amount, 'refund', reference, refund_reason, new_balance);

  RETURN QUERY SELECT target_user_id, new_balance;
END;
$function$;

REVOKE ALL ON FUNCTION public.refund_user_tokens(uuid, integer, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_user_tokens(uuid, integer, text, text, uuid) TO service_role;