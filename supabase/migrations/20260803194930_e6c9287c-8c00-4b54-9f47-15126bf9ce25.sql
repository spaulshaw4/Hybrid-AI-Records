CREATE TABLE public.lyrics_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist text NOT NULL,
  email text NOT NULL,
  package_slug text,
  package_label text,
  language text NOT NULL,
  lyrics_text text,
  file_path text,
  file_name text,
  notes text,
  status text NOT NULL DEFAULT 'received',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT INSERT ON public.lyrics_submissions TO anon, authenticated;
GRANT SELECT ON public.lyrics_submissions TO authenticated;
GRANT ALL ON public.lyrics_submissions TO service_role;

ALTER TABLE public.lyrics_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit lyrics"
ON public.lyrics_submissions
FOR INSERT
TO anon, authenticated
WITH CHECK (
  length(artist) BETWEEN 1 AND 120
  AND length(email) BETWEEN 3 AND 254
  AND length(language) BETWEEN 1 AND 64
  AND (package_slug IS NULL OR length(package_slug) <= 64)
  AND (package_label IS NULL OR length(package_label) <= 120)
  AND (lyrics_text IS NULL OR length(lyrics_text) <= 20000)
  AND (file_path IS NULL OR length(file_path) <= 512)
  AND (file_name IS NULL OR length(file_name) <= 256)
  AND (notes IS NULL OR length(notes) <= 1000)
  AND status = 'received'
  AND (lyrics_text IS NOT NULL OR file_path IS NOT NULL)
);

CREATE POLICY "Staff can read lyrics submissions"
ON public.lyrics_submissions
FOR SELECT
TO authenticated
USING (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role));

CREATE TRIGGER lyrics_submissions_set_updated_at
BEFORE UPDATE ON public.lyrics_submissions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();