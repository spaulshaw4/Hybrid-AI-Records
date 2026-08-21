-- FX rates: public read-only, admin-managed writes, service role for the refresher.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.fx_rates FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.fx_rates FROM authenticated;
GRANT SELECT ON public.fx_rates TO anon;
GRANT SELECT ON public.fx_rates TO authenticated;
GRANT ALL ON public.fx_rates TO service_role;

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can insert exchange rates" ON public.fx_rates;
CREATE POLICY "Admins can insert exchange rates"
  ON public.fx_rates FOR INSERT TO authenticated
  WITH CHECK (private.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can update exchange rates" ON public.fx_rates;
CREATE POLICY "Admins can update exchange rates"
  ON public.fx_rates FOR UPDATE TO authenticated
  USING (private.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (private.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can delete exchange rates" ON public.fx_rates;
CREATE POLICY "Admins can delete exchange rates"
  ON public.fx_rates FOR DELETE TO authenticated
  USING (private.has_role(auth.uid(), 'admin'::app_role));