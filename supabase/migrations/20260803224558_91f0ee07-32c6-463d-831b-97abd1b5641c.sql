CREATE TABLE public.session_email_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.vocal_session_requests(id) ON DELETE CASCADE,
  kind text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  outcome text NOT NULL DEFAULT 'sent',
  reason text,
  slot jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX session_email_log_request_idx ON public.session_email_log (request_id, created_at DESC);

GRANT SELECT ON public.session_email_log TO authenticated;
GRANT ALL ON public.session_email_log TO service_role;

ALTER TABLE public.session_email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read session email log"
ON public.session_email_log
FOR SELECT
TO authenticated
USING (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role));