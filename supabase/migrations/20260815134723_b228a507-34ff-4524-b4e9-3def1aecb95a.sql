CREATE TABLE public.artist_token_balances (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.artist_token_balances TO authenticated;
GRANT ALL ON public.artist_token_balances TO service_role;
ALTER TABLE public.artist_token_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own artist token balance" ON public.artist_token_balances FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.artist_token_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta integer NOT NULL,
  kind text NOT NULL,
  reference text,
  note text,
  balance_after integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artist_token_ledger_user_idx ON public.artist_token_ledger (user_id, created_at DESC);
GRANT SELECT ON public.artist_token_ledger TO authenticated;
GRANT ALL ON public.artist_token_ledger TO service_role;
ALTER TABLE public.artist_token_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own artist token ledger" ON public.artist_token_ledger FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.artist_token_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_session_id text NOT NULL UNIQUE,
  price_id text NOT NULL,
  tokens integer NOT NULL,
  amount_total integer,
  currency text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.artist_token_purchases TO authenticated;
GRANT ALL ON public.artist_token_purchases TO service_role;
ALTER TABLE public.artist_token_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own artist token purchases" ON public.artist_token_purchases FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.artist_track_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  track_id text NOT NULL,
  track_title text,
  track_artist text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, track_id)
);
GRANT SELECT ON public.artist_track_downloads TO authenticated;
GRANT ALL ON public.artist_track_downloads TO service_role;
ALTER TABLE public.artist_track_downloads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own unlocked tracks" ON public.artist_track_downloads FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.credit_artist_token_purchase(
  _user_id uuid,
  _session_id text,
  _price_id text,
  _tokens integer,
  _amount_total integer,
  _currency text
) RETURNS TABLE(credited integer, balance integer, already_credited boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted boolean := false;
  new_balance integer;
BEGIN
  INSERT INTO public.artist_token_purchases (user_id, stripe_session_id, price_id, tokens, amount_total, currency)
  VALUES (_user_id, _session_id, _price_id, _tokens, _amount_total, _currency)
  ON CONFLICT (stripe_session_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;

  IF NOT inserted THEN
    SELECT b.balance INTO new_balance FROM public.artist_token_balances b WHERE b.user_id = _user_id;
    RETURN QUERY SELECT 0, COALESCE(new_balance, 0), true;
    RETURN;
  END IF;

  INSERT INTO public.artist_token_balances (user_id, balance)
  VALUES (_user_id, _tokens)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.artist_token_balances.balance + EXCLUDED.balance,
        updated_at = now()
  RETURNING public.artist_token_balances.balance INTO new_balance;

  INSERT INTO public.artist_token_ledger (user_id, delta, kind, reference, note, balance_after)
  VALUES (_user_id, _tokens, 'purchase', _session_id, 'Artist Token purchase', new_balance);

  RETURN QUERY SELECT _tokens, new_balance, false;
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_artist_track_download(
  _user_id uuid,
  _track_id text,
  _track_title text,
  _track_artist text
) RETURNS TABLE(ok boolean, balance integer, already_owned boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owned boolean;
  new_balance integer;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.artist_track_downloads d
    WHERE d.user_id = _user_id AND d.track_id = _track_id
  ) INTO owned;

  SELECT b.balance INTO new_balance FROM public.artist_token_balances b WHERE b.user_id = _user_id;
  new_balance := COALESCE(new_balance, 0);

  IF owned THEN
    RETURN QUERY SELECT true, new_balance, true, NULL::text;
    RETURN;
  END IF;

  UPDATE public.artist_token_balances
     SET balance = balance - 1, updated_at = now()
   WHERE user_id = _user_id AND balance >= 1
  RETURNING balance INTO new_balance;

  IF new_balance IS NULL THEN
    SELECT COALESCE(b.balance, 0) INTO new_balance FROM public.artist_token_balances b WHERE b.user_id = _user_id;
    RETURN QUERY SELECT false, COALESCE(new_balance, 0), false, 'Not enough Artist Tokens.'::text;
    RETURN;
  END IF;

  INSERT INTO public.artist_track_downloads (user_id, track_id, track_title, track_artist)
  VALUES (_user_id, _track_id, _track_title, _track_artist)
  ON CONFLICT (user_id, track_id) DO NOTHING;

  INSERT INTO public.artist_token_ledger (user_id, delta, kind, reference, note, balance_after)
  VALUES (_user_id, -1, 'download', _track_id, COALESCE(_track_title, _track_id), new_balance);

  RETURN QUERY SELECT true, new_balance, false, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_artist_token_purchase(uuid, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_artist_track_download(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_artist_token_purchase(uuid, text, text, integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_artist_track_download(uuid, text, text, text) TO service_role;