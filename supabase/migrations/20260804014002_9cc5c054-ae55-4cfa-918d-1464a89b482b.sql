CREATE TABLE IF NOT EXISTS public.pricing_settings_audit (
  key text PRIMARY KEY,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.pricing_settings_audit TO service_role;
ALTER TABLE public.pricing_settings_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can read pricing audit" ON public.pricing_settings_audit
  FOR SELECT TO authenticated USING (private.has_role(auth.uid(), 'admin'::app_role));
GRANT SELECT ON public.pricing_settings_audit TO authenticated;

INSERT INTO public.pricing_settings_audit (key, updated_by, updated_at)
SELECT key, updated_by, updated_at FROM public.pricing_settings
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.pricing_settings DROP COLUMN IF EXISTS updated_by;

ALTER VIEW public.pricing_settings_public SET (security_invoker = on);
CREATE POLICY "Public can read pricing surcharge" ON public.pricing_settings
  FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.pricing_settings TO anon, authenticated;