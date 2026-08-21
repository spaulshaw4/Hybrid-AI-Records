CREATE TABLE public.support_error_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  route_id text NOT NULL DEFAULT '',
  pathname text NOT NULL DEFAULT '',
  url text,
  stage text NOT NULL DEFAULT 'render',
  params jsonb NOT NULL DEFAULT '[]'::jsonb,
  search jsonb NOT NULL DEFAULT '[]'::jsonb,
  message text,
  source text NOT NULL DEFAULT 'error-boundary',
  user_agent text,
  email_status text NOT NULL DEFAULT 'not_sent',
  email_opened_at timestamptz,
  occurrences integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.support_error_reports TO authenticated;
GRANT ALL ON public.support_error_reports TO service_role;

ALTER TABLE public.support_error_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read support error reports"
ON public.support_error_reports
FOR SELECT
TO authenticated
USING (private.has_role(auth.uid(), 'admin') OR private.has_role(auth.uid(), 'staff'));

CREATE TRIGGER support_error_reports_set_updated_at
BEFORE UPDATE ON public.support_error_reports
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX support_error_reports_created_at_idx ON public.support_error_reports (created_at DESC);