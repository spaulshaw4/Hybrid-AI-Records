-- Catalog of harvested FMA / vault stems for the mix engine (not studio user tracks).
CREATE TABLE IF NOT EXISTS public.fma_tracks (
  track_id text PRIMARY KEY,
  title text,
  artist text,
  genre text,
  duration double precision,
  bpm double precision,
  key_signature text,
  status text NOT NULL DEFAULT 'ready',
  source text NOT NULL DEFAULT 'FMA',
  stem_drums_url text,
  stem_bass_url text,
  stem_vocals_url text,
  stem_other_url text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

COMMENT ON TABLE public.fma_tracks IS 'Ingested stem catalog for the render mixer. Separate from public.tracks (studio generates).';

CREATE INDEX IF NOT EXISTS fma_tracks_status_idx ON public.fma_tracks (status);
CREATE INDEX IF NOT EXISTS fma_tracks_bpm_idx ON public.fma_tracks (bpm);

GRANT SELECT ON public.fma_tracks TO authenticated;
GRANT ALL ON public.fma_tracks TO service_role;

ALTER TABLE public.fma_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read fma catalog"
  ON public.fma_tracks FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Allow service role full access on fma_tracks" ON public.fma_tracks;
CREATE POLICY "Allow service role full access on fma_tracks"
  ON public.fma_tracks
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
