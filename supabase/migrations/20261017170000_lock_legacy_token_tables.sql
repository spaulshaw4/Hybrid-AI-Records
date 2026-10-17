-- Local migration only. Do not apply this from the app.
-- Closes legacy tables that the earlier migrations leave with RLS off, and
-- stops browser roles from executing SECURITY DEFINER token RPCs that trust
-- a caller-supplied user id. Service role keeps execute. No allow-all policies.

DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'spend_hybrid_token_and_create_session',
        'spend_hybrid_token',
        'add_hybrid_tokens'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.user_token_balances') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.user_token_balances ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON TABLE public.user_token_balances FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT SELECT ON TABLE public.user_token_balances TO authenticated';
    EXECUTE 'GRANT ALL ON TABLE public.user_token_balances TO service_role';
    EXECUTE 'DROP POLICY IF EXISTS "Users read own hybrid token balance" ON public.user_token_balances';
    EXECUTE $pol$
      CREATE POLICY "Users read own hybrid token balance"
      ON public.user_token_balances
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id)
    $pol$;
  END IF;

  IF to_regclass('public.audio_embeddings') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.audio_embeddings ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON TABLE public.audio_embeddings FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT ALL ON TABLE public.audio_embeddings TO service_role';
  END IF;
END $$;
