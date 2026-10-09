-- Authenticated artists may insert and read only their own reference objects.
-- Public read of existing masters stays as it is. Anon cannot insert.

DROP POLICY IF EXISTS "Artists insert own audio references" ON storage.objects;
DROP POLICY IF EXISTS "Artists select own audio references" ON storage.objects;

CREATE POLICY "Artists insert own audio references"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'audio-vault'
    AND (storage.foldername(name))[1] = 'references'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

CREATE POLICY "Artists select own audio references"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'audio-vault'
    AND (storage.foldername(name))[1] = 'references'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
