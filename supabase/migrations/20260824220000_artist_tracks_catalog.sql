-- Public label catalog indexed from storage bucket `artist-catalog`.
-- Rows are the source of truth for Artist Tracks + radio_ready rotation.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'artist-catalog',
  'artist-catalog',
  true,
  524288000,
  ARRAY[
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/flac',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = true,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.artist_tracks (
  id text PRIMARY KEY,
  album_id text NOT NULL,
  album_title text NOT NULL,
  artist_name text NOT NULL DEFAULT 'Hybrid AI Records',
  title text NOT NULL,
  track_number integer NOT NULL CHECK (track_number > 0),
  track_total integer,
  audio_url text NOT NULL,
  cover_url text,
  storage_path text NOT NULL UNIQUE,
  genre text,
  credits text,
  division text,
  radio_ready boolean NOT NULL DEFAULT true,
  price_tokens integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS artist_tracks_album_track_idx
  ON public.artist_tracks (album_id, track_number);

CREATE INDEX IF NOT EXISTS artist_tracks_radio_ready_idx
  ON public.artist_tracks (radio_ready)
  WHERE radio_ready = true;

COMMENT ON TABLE public.artist_tracks IS
  'Label catalog tracks synced from the public artist-catalog storage bucket.';
COMMENT ON COLUMN public.artist_tracks.audio_url IS
  'Public CDN URL for interchange playback (Artist page, album views, Radio).';
COMMENT ON COLUMN public.artist_tracks.radio_ready IS
  'When true, eligible for the Hybrid AI Radio rotation / queue merge.';

ALTER TABLE public.artist_tracks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read artist catalog" ON public.artist_tracks;
CREATE POLICY "Public read artist catalog"
  ON public.artist_tracks FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON public.artist_tracks TO anon, authenticated;
GRANT ALL ON public.artist_tracks TO service_role;
