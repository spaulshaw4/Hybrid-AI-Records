DROP POLICY IF EXISTS "Anyone can read display pricing rates" ON public.pricing_settings;
REVOKE SELECT ON public.pricing_settings FROM anon, authenticated;
GRANT ALL ON public.pricing_settings TO service_role;