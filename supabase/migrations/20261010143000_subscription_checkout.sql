-- Local migration only. Do not apply this against the remote database from the app.
-- Monthly Stripe subscriptions. Hybrid credits go to token_balances.balance because
-- spend_hybrid_tokens reads that column. D-Token credits go to profiles.d_tokens.
-- profiles primary key is user_id. Additive; does not rewrite 20261010120000.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS d_tokens integer NOT NULL DEFAULT 0;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_tier text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS subscription_status text;

COMMENT ON COLUMN public.profiles.stripe_customer_id IS
  'Stripe customer for the signed-in user. Written by the service role from Checkout.';
COMMENT ON COLUMN public.profiles.stripe_subscription_id IS
  'Active Stripe subscription id. Cleared only by a later subscription, not by cancel.';
COMMENT ON COLUMN public.profiles.subscription_tier IS
  'free, starter_999, pro_1999, or label_2999. Cancel sets free and does not zero tokens.';
COMMENT ON COLUMN public.profiles.subscription_status IS
  'active while the Stripe subscription is running; canceled after customer.subscription.deleted.';

CREATE UNIQUE INDEX IF NOT EXISTS profiles_stripe_customer_id_uniq
  ON public.profiles (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_stripe_subscription_id_uniq
  ON public.profiles (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.subscription_credit_grants (
  grant_key text PRIMARY KEY,
  user_id uuid NOT NULL,
  tier text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

COMMENT ON TABLE public.subscription_credit_grants IS
  'Idempotency receipts. checkout:<session id> sets the tier allowance once. invoice:<invoice id> adds the monthly allowance once.';

ALTER TABLE public.subscription_credit_grants ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.subscription_credit_grants TO service_role;

-- Authenticated artists can still edit display_name. They cannot mint balances or plans.
CREATE OR REPLACE FUNCTION public.protect_profile_billing_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF coalesce(auth.role(), '') = 'service_role'
     OR current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.d_tokens := 0;
    NEW.stripe_customer_id := NULL;
    NEW.stripe_subscription_id := NULL;
    NEW.subscription_tier := 'free';
    NEW.subscription_status := NULL;
    RETURN NEW;
  END IF;

  NEW.d_tokens := OLD.d_tokens;
  NEW.stripe_customer_id := OLD.stripe_customer_id;
  NEW.stripe_subscription_id := OLD.stripe_subscription_id;
  NEW.subscription_tier := OLD.subscription_tier;
  NEW.subscription_status := OLD.subscription_status;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_protect_billing_columns ON public.profiles;
CREATE TRIGGER profiles_protect_billing_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_billing_columns();

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
    expected_d := 5;
    expected_h := 20;
  ELSIF _tier = 'pro_1999' THEN
    expected_d := 12;
    expected_h := 50;
  ELSIF _tier = 'label_2999' THEN
    expected_d := 25;
    expected_h := 120;
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
