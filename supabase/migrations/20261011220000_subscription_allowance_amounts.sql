-- Replaces monthly membership allowances in apply_subscription_grant.
-- Databases that already applied 20261010143000 keep the previous function
-- until this migration runs. Routing, idempotency, and subscription_status
-- stay the same. Hybrid credits still land on token_balances.balance.
-- D-Token credits still land on profiles.d_tokens.
-- starter_999 10/10, pro_1999 15/15, label_2999 20/20.

CREATE OR REPLACE FUNCTION public.apply_subscription_grant(
  _user_id uuid,
  _grant_key text,
  _tier text,
  _kind text,
  _d_tokens integer,
  _hybrid_tokens integer,
  _stripe_customer_id text,
  _stripe_subscription_id text,
  _mode text
)
RETURNS TABLE (applied boolean, d_tokens integer, hybrid_balance integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted boolean := false;
  expected_d integer;
  expected_h integer;
  new_d integer;
  new_h integer;
BEGIN
  IF _user_id IS NULL OR _grant_key IS NULL OR btrim(_grant_key) = '' THEN
    RAISE EXCEPTION 'invalid grant';
  END IF;
  IF _kind = 'initial' AND _mode = 'set' THEN
    NULL;
  ELSIF _kind = 'cycle' AND _mode = 'add' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'invalid grant mode';
  END IF;

  IF _tier = 'starter_999' THEN
    expected_d := 10;
    expected_h := 10;
  ELSIF _tier = 'pro_1999' THEN
    expected_d := 15;
    expected_h := 15;
  ELSIF _tier = 'label_2999' THEN
    expected_d := 20;
    expected_h := 20;
  ELSE
    RAISE EXCEPTION 'invalid subscription tier';
  END IF;

  IF _d_tokens IS DISTINCT FROM expected_d OR _hybrid_tokens IS DISTINCT FROM expected_h THEN
    RAISE EXCEPTION 'token allowance does not match tier';
  END IF;

  INSERT INTO public.subscription_credit_grants (grant_key, user_id, tier, kind)
  VALUES (btrim(_grant_key), _user_id, _tier, _kind)
  ON CONFLICT (grant_key) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;

  IF NOT inserted THEN
    SELECT COALESCE(p.d_tokens, 0) INTO new_d
    FROM public.profiles p WHERE p.user_id = _user_id;
    SELECT COALESCE(tb.balance, 0) INTO new_h
    FROM public.token_balances tb WHERE tb.user_id = _user_id;
    RETURN QUERY SELECT false, COALESCE(new_d, 0), COALESCE(new_h, 0);
    RETURN;
  END IF;

  INSERT INTO public.profiles (
    user_id,
    d_tokens,
    subscription_tier,
    subscription_status,
    stripe_customer_id,
    stripe_subscription_id
  )
  VALUES (
    _user_id,
    expected_d,
    _tier,
    'active',
    NULLIF(btrim(COALESCE(_stripe_customer_id, '')), ''),
    NULLIF(btrim(COALESCE(_stripe_subscription_id, '')), '')
  )
  ON CONFLICT (user_id) DO UPDATE
    SET d_tokens = CASE
          WHEN _mode = 'set' THEN EXCLUDED.d_tokens
          ELSE public.profiles.d_tokens + EXCLUDED.d_tokens
        END,
        subscription_tier = EXCLUDED.subscription_tier,
        subscription_status = 'active',
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, public.profiles.stripe_customer_id),
        stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, public.profiles.stripe_subscription_id),
        updated_at = now()
  RETURNING public.profiles.d_tokens INTO new_d;

  -- spend_hybrid_tokens debits token_balances.balance. That is the spendable Hybrid balance.
  INSERT INTO public.token_balances (user_id, balance)
  VALUES (_user_id, expected_h)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = CASE
          WHEN _mode = 'set' THEN EXCLUDED.balance
          ELSE public.token_balances.balance + EXCLUDED.balance
        END,
        updated_at = now()
  RETURNING public.token_balances.balance INTO new_h;

  RETURN QUERY SELECT true, new_d, new_h;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_subscription_grant(uuid, text, text, text, integer, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_subscription_grant(uuid, text, text, text, integer, integer, text, text, text)
  TO service_role;
