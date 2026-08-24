-- Ensure Gate 2 vault bucket exists and is public (Replicate CDN fetch).
-- Live projects previously used raw-vault / stems-vault / renders-master;
-- the pipeline default is audio-vault (override via AUDIO_VAULT_BUCKET).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'audio-vault',
  'audio-vault',
  true,
  157286400,
  ARRAY['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/flac']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = true,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
