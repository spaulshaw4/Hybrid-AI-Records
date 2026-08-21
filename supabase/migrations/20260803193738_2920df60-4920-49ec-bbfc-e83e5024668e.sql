REVOKE SELECT ON public.pricing_settings FROM anon, authenticated;

GRANT SELECT (key, surcharge_bps, created_at, updated_at) ON public.pricing_settings TO anon, authenticated;
GRANT ALL ON public.pricing_settings TO service_role;

CREATE OR REPLACE VIEW public.pricing_settings_public
WITH (security_invoker = on) AS
  SELECT key, surcharge_bps, created_at, updated_at
  FROM public.pricing_settings;

GRANT SELECT ON public.pricing_settings_public TO anon, authenticated;
GRANT ALL ON public.pricing_settings_public TO service_role;