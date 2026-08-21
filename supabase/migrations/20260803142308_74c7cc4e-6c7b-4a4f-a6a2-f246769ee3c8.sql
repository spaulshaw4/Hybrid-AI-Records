-- Public reads only need the rate values used for quoting prices.
-- The internal "who changed it" field is no longer exposed to anon/authenticated.
REVOKE SELECT ON public.pricing_settings FROM anon, authenticated;

GRANT SELECT (key, surcharge_bps, created_at, updated_at)
  ON public.pricing_settings TO anon, authenticated;

GRANT ALL ON public.pricing_settings TO service_role;

-- Admins keep full visibility through privileged server paths (service role).
DROP POLICY IF EXISTS "Anyone can read pricing settings" ON public.pricing_settings;
CREATE POLICY "Anyone can read display pricing rates"
  ON public.pricing_settings
  FOR SELECT
  TO anon, authenticated
  USING (true);