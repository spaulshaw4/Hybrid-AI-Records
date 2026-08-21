CREATE TABLE public.fx_rates (
  currency TEXT PRIMARY KEY,
  rate NUMERIC NOT NULL CHECK (rate > 0),
  source TEXT NOT NULL DEFAULT 'open.er-api.com',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.fx_rates TO anon;
GRANT SELECT ON public.fx_rates TO authenticated;
GRANT ALL ON public.fx_rates TO service_role;

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read exchange rates"
  ON public.fx_rates FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE TRIGGER fx_rates_set_updated_at
  BEFORE UPDATE ON public.fx_rates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();