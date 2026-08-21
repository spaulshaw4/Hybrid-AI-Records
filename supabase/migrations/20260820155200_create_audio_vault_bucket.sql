-- Dedicated vault masters bucket: 150 MB, WAV / MP3 / FLAC only.
-- Dashboard equivalent: Storage → audio-vault → Edit Bucket
--   Maximum file size: 157286400
--   Allowed MIME types: audio/wav, audio/x-wav, audio/mpeg, audio/mp3, audio/flac

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'audio-vault',
  'audio-vault',
  false,
  157286400,
  ARRAY['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/flac']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Artists read own audio-vault objects" ON storage.objects;
DROP POLICY IF EXISTS "Service role manages audio-vault" ON storage.objects;

-- Authenticated artists never list the whole bucket; playback uses signed URLs
-- minted by the API. Service role bypasses RLS for upload/delete.
CREATE POLICY "Artists read own audio-vault objects"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'audio-vault'
    AND owner = auth.uid()
  );
