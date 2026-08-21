CREATE TABLE public.funnel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event text NOT NULL,
  package_slug text,
  step text,
  step_index smallint,
  mode text,
  currency text,
  reference text,
  visitor_session text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX funnel_events_created_at_idx ON public.funnel_events (created_at DESC);
CREATE INDEX funnel_events_event_idx ON public.funnel_events (event, package_slug);

GRANT INSERT ON public.funnel_events TO anon, authenticated;
GRANT SELECT ON public.funnel_events TO authenticated;
GRANT ALL ON public.funnel_events TO service_role;

ALTER TABLE public.funnel_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can record a funnel event"
  ON public.funnel_events FOR INSERT TO anon, authenticated
  WITH CHECK (
    length(event) BETWEEN 1 AND 64
    AND length(visitor_session) BETWEEN 8 AND 64
    AND (package_slug IS NULL OR length(package_slug) <= 64)
    AND (step IS NULL OR length(step) <= 32)
    AND (mode IS NULL OR mode IN ('single','bundle'))
    AND (currency IS NULL OR length(currency) <= 8)
    AND (reference IS NULL OR length(reference) <= 40)
  );

CREATE POLICY "Staff can read funnel events"
  ON public.funnel_events FOR SELECT TO authenticated
  USING (private.has_role(auth.uid(), 'admin') OR private.has_role(auth.uid(), 'staff'));