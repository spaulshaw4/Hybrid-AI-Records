-- Base pricing table: no public reach at all.
REVOKE ALL ON public.pricing_settings FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.pricing_settings TO service_role;

-- Sanitized view: read-only, safe columns only, never writable by clients.
ALTER VIEW public.pricing_settings_public SET (security_barrier = true);
REVOKE ALL ON public.pricing_settings_public FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.pricing_settings_public TO anon, authenticated;
GRANT ALL ON public.pricing_settings_public TO service_role;

-- Audit log holds admin user ids: anon gets nothing, authenticated read-only
-- (still gated to admins by RLS), writes only from the backend.
REVOKE ALL ON public.pricing_settings_audit FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.pricing_settings_audit TO authenticated;
GRANT ALL ON public.pricing_settings_audit TO service_role;