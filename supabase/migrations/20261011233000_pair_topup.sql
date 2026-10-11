-- One-time Hybrid + D-Token pairs (pair5 / pair10 / pair25).
-- Not a subscription grant: subscription_tier and subscription_status stay untouched.
-- Idempotent on stripe_session_id via credit_token_purchase. A replay does not add tokens twice.

CREATE OR REPLACE FUNCTION public.credit_pair_topup(
  _user_id uuid,
  _session_id text,
  _price_id text,
  _tokens integer,
  _d_tokens integer,
  _amount_total integer,
  _currency text
)
RETURNS TABLE (credited integer, balance integer, d_tokens integer, already_credited boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credited integer;
  v_balance integer;
  v_already boolean;
  new_d integer;
BEGIN
  IF _tokens IS NULL OR _tokens NOT IN (5, 10, 25) OR _d_tokens IS DISTINCT FROM _tokens THEN
    RAISE EXCEPTION 'invalid pair amount';
  END IF;

  SELECT c.credited, c.balance, c.already_credited
    INTO v_credited, v_balance, v_already
  FROM public.credit_token_purchase(
    _user_id,
    _session_id,
    _price_id,
    _tokens,
    _amount_total,
    _currency
  ) AS c;

  IF v_already THEN
    SELECT COALESCE(p.d_tokens, 0) INTO new_d
    FROM public.profiles p
    WHERE p.user_id = _user_id;
    RETURN QUERY SELECT 0, COALESCE(v_balance, 0), COALESCE(new_d, 0), true;
    RETURN;
  END IF;

  UPDATE public.profiles
    SET d_tokens = public.profiles.d_tokens + _d_tokens,
        updated_at = now()
    WHERE user_id = _user_id
    RETURNING public.profiles.d_tokens INTO new_d;

  IF NOT FOUND THEN
    INSERT INTO public.profiles (user_id, d_tokens)
    VALUES (_user_id, _d_tokens)
    RETURNING public.profiles.d_tokens INTO new_d;
  END IF;

  RETURN QUERY SELECT _tokens, v_balance, new_d, false;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_pair_topup(uuid, text, text, integer, integer, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_pair_topup(uuid, text, text, integer, integer, integer, text)
  TO service_role;
