REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.pricing_settings FROM anon, authenticated;
REVOKE ALL ON public.pricing_settings FROM anon, authenticated;
GRANT SELECT (key, surcharge_bps, created_at, updated_at) ON public.pricing_settings TO anon, authenticated;
GRANT ALL ON public.pricing_settings TO service_role;