-- Hybrid Engine stem catalog: one row per generate, with intro / bed / vocal / master URLs.
CREATE TABLE public.tracks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  genre_prompt text,
  lyrics text,
  intro_url text,
  instrumental_url text,
  vocal_url text,
  master_url text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now())
);

COMMENT ON TABLE public.tracks IS 'Studio pipeline stems and mixed master for each generate.';
COMMENT ON COLUMN public.tracks.intro_url IS '30-second intro tag.';
COMMENT ON COLUMN public.tracks.instrumental_url IS 'Instrumental bed.';
COMMENT ON COLUMN public.tracks.vocal_url IS 'Cloned vocal stem.';
COMMENT ON COLUMN public.tracks.master_url IS 'Final mixed/mastered track.';

CREATE INDEX tracks_user_created_idx ON public.tracks (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tracks TO authenticated;
GRANT ALL ON public.tracks TO service_role;

ALTER TABLE public.tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Artists manage own tracks"
  ON public.tracks FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
