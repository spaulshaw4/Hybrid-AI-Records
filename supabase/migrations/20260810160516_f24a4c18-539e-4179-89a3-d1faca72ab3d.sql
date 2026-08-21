CREATE TABLE public.studio_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  artist text NOT NULL,
  email text NOT NULL,
  title text NOT NULL DEFAULT '',
  style text NOT NULL DEFAULT '',
  brief text NOT NULL DEFAULT '',
  instrumental boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued',
  delivery_url text,
  delivery_path text,
  delivery_note text,
  delivered_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON public.studio_requests TO authenticated;
GRANT ALL ON public.studio_requests TO service_role;

ALTER TABLE public.studio_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read studio requests"
ON public.studio_requests FOR SELECT TO authenticated
USING (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role));

CREATE POLICY "Staff can update studio requests"
ON public.studio_requests FOR UPDATE TO authenticated
USING (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role))
WITH CHECK (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role));

CREATE TRIGGER studio_requests_set_updated_at
BEFORE UPDATE ON public.studio_requests
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX studio_requests_status_created_idx ON public.studio_requests (status, created_at DESC);