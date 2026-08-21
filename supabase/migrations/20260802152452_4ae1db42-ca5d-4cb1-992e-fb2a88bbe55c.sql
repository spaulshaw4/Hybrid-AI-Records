CREATE TABLE public.pricing_settings (
  key text PRIMARY KEY,
  surcharge_bps jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.pricing_settings TO anon;
GRANT SELECT ON public.pricing_settings TO authenticated;
GRANT ALL ON public.pricing_settings TO service_role;

ALTER TABLE public.pricing_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read pricing settings"
  ON public.pricing_settings FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE TRIGGER pricing_settings_updated_at
  BEFORE UPDATE ON public.pricing_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.pricing_settings (key, surcharge_bps)
VALUES ('surcharge', '{"usd":0,"eur":200,"gbp":200,"ngn":200,"zar":200}'::jsonb);