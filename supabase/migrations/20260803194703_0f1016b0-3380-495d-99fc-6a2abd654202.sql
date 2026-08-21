CREATE TABLE public.vocal_session_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist text NOT NULL,
  email text NOT NULL,
  package_slug text,
  package_label text,
  timezone text NOT NULL,
  timezone_offset_minutes integer,
  slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  status text NOT NULL DEFAULT 'requested',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT INSERT ON public.vocal_session_requests TO anon, authenticated;
GRANT SELECT ON public.vocal_session_requests TO authenticated;
GRANT ALL ON public.vocal_session_requests TO service_role;

ALTER TABLE public.vocal_session_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can request a vocal session"
ON public.vocal_session_requests FOR INSERT TO anon, authenticated
WITH CHECK (
  length(artist) BETWEEN 1 AND 120
  AND length(email) BETWEEN 3 AND 254
  AND length(timezone) BETWEEN 1 AND 64
  AND (package_slug IS NULL OR length(package_slug) <= 64)
  AND (package_label IS NULL OR length(package_label) <= 120)
  AND (notes IS NULL OR length(notes) <= 1000)
  AND status = 'requested'
  AND jsonb_typeof(slots) = 'array'
  AND jsonb_array_length(slots) BETWEEN 1 AND 5
);

CREATE POLICY "Staff can read vocal session requests"
ON public.vocal_session_requests FOR SELECT TO authenticated
USING (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role));

CREATE TRIGGER set_vocal_session_requests_updated_at
BEFORE UPDATE ON public.vocal_session_requests
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();