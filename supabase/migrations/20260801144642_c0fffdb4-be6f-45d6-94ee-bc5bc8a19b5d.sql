CREATE TABLE public.track_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code text NOT NULL UNIQUE,
  artist text NOT NULL,
  email text NOT NULL,
  package_label text NOT NULL,
  file_name text,
  link text,
  notes text,
  acknowledged boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'received',
  status_note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT ALL ON public.track_requests TO service_role;

ALTER TABLE public.track_requests ENABLE ROW LEVEL SECURITY;

CREATE INDEX track_requests_email_idx ON public.track_requests (lower(email));

CREATE TRIGGER track_requests_set_updated_at
BEFORE UPDATE ON public.track_requests
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();