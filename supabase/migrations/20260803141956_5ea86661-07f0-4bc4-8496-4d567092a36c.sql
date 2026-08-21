-- Verifies that a reference code belongs to the given contact email.
CREATE OR REPLACE FUNCTION private.track_contact_matches(_ref text, _email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _ref IS NOT NULL
     AND length(_ref) > 0
     AND _email IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.track_requests
        WHERE reference_code = _ref
          AND lower(email) = lower(btrim(_email))
     );
$$;

REVOKE ALL ON FUNCTION private.track_contact_matches(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.track_contact_matches(text, text) TO service_role;

-- Knowing a reference code is no longer enough to write into that folder.
DROP POLICY IF EXISTS "Artist uploads must target a real submission" ON storage.objects;

CREATE POLICY "Artist uploads require a verified owner"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'artist-uploads'
  AND (
    (
      (storage.foldername(name))[1] = 'u'
      AND (storage.foldername(name))[2] = (auth.uid())::text
    )
    OR private.has_role(auth.uid(), 'admin'::app_role)
  )
);