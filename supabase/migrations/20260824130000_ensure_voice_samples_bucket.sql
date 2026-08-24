-- Private voice sample clips for custom vocal / Fish Audio reference.
-- Path convention: {auth.uid()}/{timestamp}-{filename}
-- Policies already added in 20260814114513_*; this ensures the bucket exists.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'voice-samples',
  'voice-samples',
  false,
  26214400,
  ARRAY[
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/webm',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Re-assert authenticated own-folder policies (idempotent).
DROP POLICY IF EXISTS "Artists upload own voice samples" ON storage.objects;
DROP POLICY IF EXISTS "Artists read own voice samples" ON storage.objects;
DROP POLICY IF EXISTS "Artists delete own voice samples" ON storage.objects;
DROP POLICY IF EXISTS "Artists update own voice samples" ON storage.objects;

CREATE POLICY "Artists upload own voice samples"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'voice-samples'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Artists read own voice samples"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'voice-samples'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Artists update own voice samples"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'voice-samples'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'voice-samples'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Artists delete own voice samples"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'voice-samples'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
