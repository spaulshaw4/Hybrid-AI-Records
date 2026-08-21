CREATE OR REPLACE FUNCTION public.credit_token_purchase(
  _user_id uuid,
  _session_id text,
  _price_id text,
  _tokens integer,
  _amount_total integer,
  _currency text
)
RETURNS TABLE (credited integer, balance integer, already_credited boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted boolean := false;
  new_balance integer;
BEGIN
  IF _tokens IS NULL OR _tokens <= 0 THEN
    RAISE EXCEPTION 'invalid token amount';
  END IF;

  INSERT INTO public.token_purchases (user_id, stripe_session_id, price_id, tokens, amount_total, currency)
  VALUES (_user_id, _session_id, _price_id, _tokens, _amount_total, _currency)
  ON CONFLICT (stripe_session_id) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;

  IF inserted THEN
    INSERT INTO public.token_balances (user_id, balance)
    VALUES (_user_id, _tokens)
    ON CONFLICT (user_id) DO UPDATE
      SET balance = public.token_balances.balance + EXCLUDED.balance,
          updated_at = now()
    RETURNING public.token_balances.balance INTO new_balance;

    RETURN QUERY SELECT _tokens, new_balance, false;
  ELSE
    SELECT COALESCE(tb.balance, 0) INTO new_balance
    FROM public.token_balances tb WHERE tb.user_id = _user_id;
    RETURN QUERY SELECT 0, COALESCE(new_balance, 0), true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_token_purchase(uuid, text, text, integer, integer, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_token_purchase(uuid, text, text, integer, integer, text) TO service_role;