ALTER VIEW public.pricing_settings_public SET (security_invoker = on);

GRANT SELECT (key, surcharge_bps, created_at, updated_at) ON public.pricing_settings TO anon, authenticated;

CREATE POLICY "Public can read safe pricing columns"
  ON public.pricing_settings FOR SELECT
  TO anon, authenticated
  USING (true);