CREATE TABLE public.pricing_access_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_role text NOT NULL,
  actor_user_id uuid,
  source text NOT NULL,
  outcome text NOT NULL,
  detail text,
  occurrences integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pricing_access_alerts_dedupe
  ON public.pricing_access_alerts (actor_role, source, outcome, coalesce(actor_user_id, '00000000-0000-0000-0000-000000000000'::uuid));

GRANT SELECT ON public.pricing_access_alerts TO authenticated;
GRANT ALL ON public.pricing_access_alerts TO service_role;

ALTER TABLE public.pricing_access_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read pricing access alerts"
  ON public.pricing_access_alerts
  FOR SELECT
  TO authenticated
  USING (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role));

CREATE TRIGGER pricing_access_alerts_set_updated_at
  BEFORE UPDATE ON public.pricing_access_alerts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();