-- Automatic refund for failed studio generations (service_role only).
-- Separate from admin refund_user_tokens, which requires an admin actor.
CREATE OR REPLACE FUNCTION public.refund_hybrid_generation_tokens(
  _user_id uuid,
  _amount integer,
  _note text DEFAULT NULL::text,
  _idempotency_key text DEFAULT NULL::text
)
RETURNS TABLE(ok boolean, balance integer, already_applied boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  idem text := NULLIF(btrim(_idempotency_key), '');
  current_balance integer;
  new_balance integer;
BEGIN
  IF _amount IS NULL OR _amount < 1 OR _amount > 50 THEN
    RAISE EXCEPTION 'invalid token amount';
  END IF;

  IF idem IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.token_ledger tl WHERE tl.idempotency_key = idem
  ) THEN
    SELECT COALESCE(tb.balance, 0) INTO current_balance
    FROM public.token_balances tb
    WHERE tb.user_id = _user_id;
    RETURN QUERY SELECT true, COALESCE(current_balance, 0), true, NULL::text;
    RETURN;
  END IF;

  INSERT INTO public.token_balances (user_id, balance)
  VALUES (_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.token_balances AS tb
     SET balance = tb.balance + _amount,
         updated_at = now()
   WHERE tb.user_id = _user_id
  RETURNING tb.balance INTO new_balance;

  IF new_balance IS NULL THEN
    RETURN QUERY SELECT false, 0, false, 'Token balance row missing.'::text;
    RETURN;
  END IF;

  INSERT INTO public.token_ledger (
    user_id, delta, kind, reference, note, balance_after, idempotency_key
  )
  VALUES (
    _user_id,
    _amount,
    'refund',
    NULL,
    COALESCE(NULLIF(btrim(_note), ''), 'Refund for failed generation'),
    new_balance,
    idem
  );

  RETURN QUERY SELECT true, new_balance, false, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.refund_hybrid_generation_tokens(uuid, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_hybrid_generation_tokens(uuid, integer, text, text)
  TO service_role;
