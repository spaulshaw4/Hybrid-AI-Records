CREATE OR REPLACE FUNCTION public.redeem_artist_track_download(_user_id uuid, _track_id text, _track_title text, _track_artist text)
 RETURNS TABLE(ok boolean, balance integer, already_owned boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  claimed boolean := false;
  new_balance integer;
BEGIN
  -- Claim ownership first. The unique (user_id, track_id) index makes this the
  -- single source of truth: only the insert that actually creates the row may
  -- spend a token, so concurrent clicks can never double-charge.
  INSERT INTO public.artist_track_downloads (user_id, track_id, track_title, track_artist)
  VALUES (_user_id, _track_id, _track_title, _track_artist)
  ON CONFLICT (user_id, track_id) DO NOTHING;
  GET DIAGNOSTICS claimed = ROW_COUNT;

  SELECT COALESCE(b.balance, 0) INTO new_balance
  FROM public.artist_token_balances b WHERE b.user_id = _user_id;
  new_balance := COALESCE(new_balance, 0);

  IF NOT claimed THEN
    -- Already owned: downloading again is free.
    RETURN QUERY SELECT true, new_balance, true, NULL::text;
    RETURN;
  END IF;

  UPDATE public.artist_token_balances
     SET balance = balance - 1, updated_at = now()
   WHERE user_id = _user_id AND balance >= 1
  RETURNING balance INTO new_balance;

  IF new_balance IS NULL THEN
    -- Not enough tokens: release the claim so the track stays locked.
    DELETE FROM public.artist_track_downloads
     WHERE user_id = _user_id AND track_id = _track_id;
    SELECT COALESCE(b.balance, 0) INTO new_balance
    FROM public.artist_token_balances b WHERE b.user_id = _user_id;
    RETURN QUERY SELECT false, COALESCE(new_balance, 0), false, 'Not enough Artist Tokens.'::text;
    RETURN;
  END IF;

  INSERT INTO public.artist_token_ledger (user_id, delta, kind, reference, note, balance_after)
  VALUES (_user_id, -1, 'download', _track_id, COALESCE(_track_title, _track_id), new_balance);

  RETURN QUERY SELECT true, new_balance, false, NULL::text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.spend_hybrid_tokens(_user_id uuid, _amount integer, _note text DEFAULT NULL::text, _idempotency_key text DEFAULT NULL::text)
 RETURNS TABLE(ok boolean, balance integer, already_applied boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  idem text := NULLIF(btrim(_idempotency_key), '');
  new_balance integer;
BEGIN
  IF _amount IS NULL OR _amount < 1 OR _amount > 50 THEN
    RAISE EXCEPTION 'invalid token amount';
  END IF;

  IF idem IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.token_ledger tl WHERE tl.idempotency_key = idem
  ) THEN
    SELECT COALESCE(tb.balance, 0) INTO new_balance
    FROM public.token_balances tb WHERE tb.user_id = _user_id;
    RETURN QUERY SELECT true, COALESCE(new_balance, 0), true, NULL::text;
    RETURN;
  END IF;

  UPDATE public.token_balances
     SET balance = balance - _amount, updated_at = now()
   WHERE user_id = _user_id AND balance >= _amount
  RETURNING balance INTO new_balance;

  IF new_balance IS NULL THEN
    SELECT COALESCE(tb.balance, 0) INTO new_balance
    FROM public.token_balances tb WHERE tb.user_id = _user_id;
    RETURN QUERY SELECT false, COALESCE(new_balance, 0), false,
      'Not enough Hybrid Tokens. Buy more to keep generating.'::text;
    RETURN;
  END IF;

  INSERT INTO public.token_ledger (user_id, delta, kind, reference, note, balance_after, idempotency_key)
  VALUES (_user_id, -_amount, 'generation', NULL, _note, new_balance, idem);

  RETURN QUERY SELECT true, new_balance, false, NULL::text;
END;
$function$;

CREATE UNIQUE INDEX IF NOT EXISTS token_ledger_idempotency_key_uniq
  ON public.token_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;