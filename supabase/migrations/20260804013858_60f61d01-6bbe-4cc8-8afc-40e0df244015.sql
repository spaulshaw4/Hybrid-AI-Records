DROP POLICY IF EXISTS "Public can read safe pricing columns" ON public.pricing_settings;
REVOKE ALL ON public.pricing_settings FROM anon, authenticated;
ALTER VIEW public.pricing_settings_public SET (security_invoker = off);
GRANT SELECT ON public.pricing_settings_public TO anon, authenticated;