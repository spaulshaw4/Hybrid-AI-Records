-- Public read for the existing audio-vault bucket.
-- Idempotent: sets public = true, drops only the three policy names below,
-- then recreates the public SELECT. Does not grant anon INSERT or DELETE.
-- Does not drop other policies and does not change file_size_limit or mime types.

UPDATE storage.buckets
SET public = true
WHERE id = 'audio-vault';

DROP POLICY IF EXISTS "Allow uploads to audio vault" ON storage.objects;
DROP POLICY IF EXISTS "Allow deletes from audio vault" ON storage.objects;
DROP POLICY IF EXISTS "Public can view audio vault files" ON storage.objects;

CREATE POLICY "Public can view audio vault files"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'audio-vault');
