-- Reset browser-facing privileges, then re-grant exactly what each table's
-- policies already allow. RLS was doing all the work; these grants make the
-- second lock match the first, so a future over-broad policy can't hand the
-- browser write access to money or role tables.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.relname);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t.relname);
  END LOOP;
END $$;

-- Owner-managed records
GRANT SELECT, INSERT, UPDATE, DELETE ON public.application_drafts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.radio_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.studio_tracks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_profiles TO authenticated;

-- Read-only for the owner / staff
GRANT SELECT ON public.artist_token_balances TO authenticated;
GRANT SELECT ON public.artist_token_ledger TO authenticated;
GRANT SELECT ON public.artist_token_purchases TO authenticated;
GRANT SELECT ON public.artist_track_downloads TO authenticated;
GRANT SELECT ON public.token_balances TO authenticated;
GRANT SELECT ON public.token_ledger TO authenticated;
GRANT SELECT ON public.token_purchases TO authenticated;
GRANT SELECT ON public.token_audit_log TO authenticated;
GRANT SELECT ON public.user_roles TO authenticated;
GRANT SELECT ON public.index_coverage_snapshots TO authenticated;
GRANT SELECT ON public.pricing_access_alerts TO authenticated;
GRANT SELECT ON public.pricing_settings_audit TO authenticated;
GRANT SELECT ON public.session_email_log TO authenticated;
GRANT SELECT ON public.support_error_reports TO authenticated;

-- Staff review queues (read + status updates)
GRANT SELECT, UPDATE ON public.studio_requests TO authenticated;
GRANT SELECT, UPDATE ON public.track_requests TO authenticated;
GRANT SELECT, UPDATE ON public.user_notifications TO authenticated;

-- Public reads
GRANT SELECT ON public.fx_rates TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.fx_rates TO authenticated; -- admin-only via policy
GRANT SELECT ON public.translation_overrides TO anon, authenticated;

-- Public submissions (insert-only for visitors)
GRANT INSERT ON public.funnel_events TO anon, authenticated;
GRANT SELECT ON public.funnel_events TO authenticated;
GRANT INSERT ON public.lyrics_submissions TO anon, authenticated;
GRANT SELECT ON public.lyrics_submissions TO authenticated;
GRANT INSERT ON public.upload_audit_log TO anon, authenticated;
GRANT SELECT ON public.upload_audit_log TO authenticated;
GRANT INSERT ON public.vocal_session_requests TO anon, authenticated;
GRANT SELECT ON public.vocal_session_requests TO authenticated;

-- Resumable form drafts (token-gated by policy)
GRANT SELECT, UPDATE ON public.form_drafts TO anon, authenticated;