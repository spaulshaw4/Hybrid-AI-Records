-- Remove blanket column access for public roles, then re-grant only display columns.
REVOKE SELECT ON public.pricing_settings FROM anon, authenticated;

GRANT SELECT (key, surcharge_bps, created_at, updated_at)
  ON public.pricing_settings TO anon, authenticated;

GRANT ALL ON public.pricing_settings TO service_role;