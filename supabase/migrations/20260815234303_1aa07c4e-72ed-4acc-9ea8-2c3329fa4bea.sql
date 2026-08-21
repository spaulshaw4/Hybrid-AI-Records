CREATE TABLE IF NOT EXISTS public.v_token_balances (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 0,
  updated_at timestamptz not null default now()
);

GRANT SELECT ON public.v_token_balances TO authenticated;
GRANT ALL ON public.v_token_balances TO service_role;
ALTER TABLE public.v_token_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own v token balance"
  ON public.v_token_balances FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.v_token_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  kind text not null,
  reference text,
  note text,
  balance_after integer,
  created_at timestamptz not null default now()
);

GRANT SELECT ON public.v_token_ledger TO authenticated;
GRANT ALL ON public.v_token_ledger TO service_role;
ALTER TABLE public.v_token_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own v token ledger"
  ON public.v_token_ledger FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE UNIQUE INDEX IF NOT EXISTS v_token_ledger_reference_key
  ON public.v_token_ledger (reference) WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS v_token_ledger_user_created_idx
  ON public.v_token_ledger (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.credit_v_token_purchase(
  _user_id uuid,
  _session_id text,
  _price_id text,
  _tokens integer,
  _amount_total integer DEFAULT NULL,
  _currency text DEFAULT NULL
)
RETURNS TABLE(credited integer, balance integer, already_credited boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_balance integer;
  inserted boolean := false;
BEGIN
  IF _tokens IS NULL OR _tokens <= 0 OR _tokens > 100 THEN
    RAISE EXCEPTION 'invalid v token amount';
  END IF;

  INSERT INTO public.v_token_ledger (user_id, delta, kind, reference, note)
  VALUES (_user_id, _tokens, 'purchase', _session_id,
          COALESCE(_price_id, '') ||
          CASE WHEN _amount_total IS NULL THEN '' ELSE ' · ' || _amount_total::text || ' ' || COALESCE(_currency, 'usd') END)
  ON CONFLICT (reference) WHERE reference IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;

  IF NOT inserted THEN
    SELECT b.balance INTO new_balance FROM public.v_token_balances b WHERE b.user_id = _user_id;
    RETURN QUERY SELECT 0, COALESCE(new_balance, 0), true;
    RETURN;
  END IF;

  INSERT INTO public.v_token_balances (user_id, balance)
  VALUES (_user_id, _tokens)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.v_token_balances.balance + EXCLUDED.balance,
        updated_at = now()
  RETURNING public.v_token_balances.balance INTO new_balance;

  UPDATE public.v_token_ledger SET balance_after = new_balance
  WHERE reference = _session_id;

  RETURN QUERY SELECT _tokens, new_balance, false;
END;
$function$;

REVOKE ALL ON FUNCTION public.credit_v_token_purchase(uuid, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_v_token_purchase(uuid, text, text, integer, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION public.spend_v_tokens(
  _user_id uuid,
  _amount integer,
  _note text DEFAULT NULL,
  _idempotency_key text DEFAULT NULL
)
RETURNS TABLE(ok boolean, balance integer, already_applied boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  current_balance integer;
  new_balance integer;
  inserted boolean := false;
BEGIN
  IF _amount IS NULL OR _amount <= 0 OR _amount > 50 THEN
    RAISE EXCEPTION 'invalid v token amount';
  END IF;

  IF _idempotency_key IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.v_token_ledger l WHERE l.reference = _idempotency_key) THEN
      SELECT b.balance INTO current_balance FROM public.v_token_balances b WHERE b.user_id = _user_id;
      RETURN QUERY SELECT true, COALESCE(current_balance, 0), true, NULL::text;
      RETURN;
    END IF;
  END IF;

  SELECT b.balance INTO current_balance FROM public.v_token_balances b
  WHERE b.user_id = _user_id FOR UPDATE;

  IF COALESCE(current_balance, 0) < _amount THEN
    RETURN QUERY SELECT false, COALESCE(current_balance, 0), false,
      'Not enough V Tokens. Buy more to keep rendering.'::text;
    RETURN;
  END IF;

  UPDATE public.v_token_balances
    SET balance = balance - _amount, updated_at = now()
    WHERE user_id = _user_id
    RETURNING balance INTO new_balance;

  INSERT INTO public.v_token_ledger (user_id, delta, kind, reference, note, balance_after)
  VALUES (_user_id, -_amount, 'render', _idempotency_key, _note, new_balance);

  RETURN QUERY SELECT true, new_balance, false, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.spend_v_tokens(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spend_v_tokens(uuid, integer, text, text) TO service_role;