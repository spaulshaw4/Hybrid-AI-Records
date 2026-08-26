-- Fix spend_hybrid_tokens: RETURNS TABLE output columns (`balance`, `ok`, …)
-- shadow table columns inside the function body. Unqualified `balance` in
-- UPDATE … SET/WHERE resolved to the uninitialized OUT param (NULL), so the
-- debit never applied (or tried to write NULL) while SELECT still reported a
-- healthy balance — producing HTTP 402 with balance >= requiredTokens.
CREATE OR REPLACE FUNCTION public.spend_hybrid_tokens(
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

  -- Lock the row; create a zero-balance row if the user was never credited.
  INSERT INTO public.token_balances (user_id, balance)
  VALUES (_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT tb.balance INTO current_balance
  FROM public.token_balances tb
  WHERE tb.user_id = _user_id
  FOR UPDATE;

  IF COALESCE(current_balance, 0) < _amount THEN
    RETURN QUERY SELECT false, COALESCE(current_balance, 0), false,
      'Not enough Hybrid Tokens. Buy more to keep generating.'::text;
    RETURN;
  END IF;

  UPDATE public.token_balances AS tb
     SET balance = tb.balance - _amount,
         updated_at = now()
   WHERE tb.user_id = _user_id
     AND tb.balance >= _amount
  RETURNING tb.balance INTO new_balance;

  IF new_balance IS NULL THEN
    SELECT COALESCE(tb.balance, 0) INTO current_balance
    FROM public.token_balances tb
    WHERE tb.user_id = _user_id;
    RETURN QUERY SELECT false, COALESCE(current_balance, 0), false,
      'Not enough Hybrid Tokens. Buy more to keep generating.'::text;
    RETURN;
  END IF;

  INSERT INTO public.token_ledger (
    user_id, delta, kind, reference, note, balance_after, idempotency_key
  )
  VALUES (
    _user_id, -_amount, 'generation', NULL, _note, new_balance, idem
  );

  RETURN QUERY SELECT true, new_balance, false, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.spend_hybrid_tokens(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spend_hybrid_tokens(uuid, integer, text, text) TO service_role;
