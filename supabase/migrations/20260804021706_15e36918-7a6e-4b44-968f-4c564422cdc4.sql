-- Trusted reader: returns only safe pricing columns, never updated_by.
CREATE OR REPLACE FUNCTION public.pricing_settings_public_rows()
RETURNS TABLE (
  key text,
  surcharge_bps jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.key, p.surcharge_bps, p.created_at, p.updated_at
  FROM public.pricing_settings p;
$$;

REVOKE ALL ON FUNCTION public.pricing_settings_public_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pricing_settings_public_rows() TO anon, authenticated, service_role;

DROP VIEW IF EXISTS public.pricing_settings_public;

-- security_invoker view (no SECURITY DEFINER property) over the trusted reader.
CREATE VIEW public.pricing_settings_public
WITH (security_invoker = true, security_barrier = true) AS
  SELECT key, surcharge_bps, created_at, updated_at
  FROM public.pricing_settings_public_rows();

REVOKE ALL ON public.pricing_settings_public FROM PUBLIC;
GRANT SELECT ON public.pricing_settings_public TO anon, authenticated, service_role;