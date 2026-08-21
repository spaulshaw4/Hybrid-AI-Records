CREATE OR REPLACE FUNCTION private.is_track_reference(_ref text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _ref IS NOT NULL
     AND length(_ref) > 0
     AND EXISTS (SELECT 1 FROM public.track_requests WHERE reference_code = _ref);
$$;

REVOKE ALL ON FUNCTION private.is_track_reference(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.is_track_reference(text) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Anyone can upload artist files" ON storage.objects;

CREATE POLICY "Artist uploads must target a real submission"
ON storage.objects FOR INSERT TO anon, authenticated
WITH CHECK (
  bucket_id = 'artist-uploads'
  AND (
    private.is_track_reference((storage.foldername(name))[1])
    OR (auth.uid() IS NOT NULL AND (storage.foldername(name))[1] = 'u' AND (storage.foldername(name))[2] = auth.uid()::text)
  )
);

CREATE POLICY "Owners and admins can read artist uploads"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'artist-uploads'
  AND (owner = auth.uid() OR private.has_role(auth.uid(), 'admin'::app_role))
);

CREATE POLICY "Owners and admins can update artist uploads"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'artist-uploads'
  AND (owner = auth.uid() OR private.has_role(auth.uid(), 'admin'::app_role))
)
WITH CHECK (
  bucket_id = 'artist-uploads'
  AND (owner = auth.uid() OR private.has_role(auth.uid(), 'admin'::app_role))
);

CREATE POLICY "Owners and admins can delete artist uploads"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'artist-uploads'
  AND (owner = auth.uid() OR private.has_role(auth.uid(), 'admin'::app_role))
);