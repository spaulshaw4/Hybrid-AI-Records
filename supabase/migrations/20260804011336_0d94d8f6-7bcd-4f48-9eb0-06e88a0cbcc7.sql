ALTER VIEW public.pricing_settings_public SET (security_invoker = on);
GRANT SELECT (key, surcharge_bps, updated_at) ON public.pricing_settings TO anon, authenticated;
DROP POLICY IF EXISTS "Public can read pricing surcharge" ON public.pricing_settings;
CREATE POLICY "Public can read pricing surcharge"
  ON public.pricing_settings FOR SELECT
  TO anon, authenticated
  USING (true);