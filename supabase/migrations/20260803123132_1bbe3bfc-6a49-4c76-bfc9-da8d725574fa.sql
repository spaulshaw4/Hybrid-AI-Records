CREATE TABLE public.upload_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  bucket text NOT NULL DEFAULT 'artist-uploads',
  object_path text NOT NULL,
  file_name text,
  file_size bigint,
  reference_code text,
  user_id uuid,
  outcome text NOT NULL DEFAULT 'success',
  error_message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT INSERT ON public.upload_audit_log TO anon, authenticated;
GRANT SELECT ON public.upload_audit_log TO authenticated;
GRANT ALL ON public.upload_audit_log TO service_role;

ALTER TABLE public.upload_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can record an upload action"
ON public.upload_audit_log
FOR INSERT
TO anon, authenticated
WITH CHECK (
  action = ANY (ARRAY['upload'::text, 'replace'::text, 'delete'::text])
  AND outcome = ANY (ARRAY['success'::text, 'failed'::text])
  AND length(bucket) <= 64
  AND length(object_path) BETWEEN 1 AND 512
  AND (file_name IS NULL OR length(file_name) <= 256)
  AND (file_size IS NULL OR (file_size >= 0 AND file_size <= 5368709120))
  AND (reference_code IS NULL OR length(reference_code) <= 64)
  AND (error_message IS NULL OR length(error_message) <= 500)
  AND (user_id IS NULL OR user_id = auth.uid())
);

CREATE POLICY "Staff can read the upload audit log"
ON public.upload_audit_log
FOR SELECT
TO authenticated
USING (
  private.has_role(auth.uid(), 'admin'::app_role)
  OR private.has_role(auth.uid(), 'staff'::app_role)
);

CREATE INDEX upload_audit_log_created_at_idx ON public.upload_audit_log (created_at DESC);
CREATE INDEX upload_audit_log_reference_idx ON public.upload_audit_log (reference_code);