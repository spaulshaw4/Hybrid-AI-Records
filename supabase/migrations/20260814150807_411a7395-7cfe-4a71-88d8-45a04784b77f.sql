CREATE TABLE public.studio_tracks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Untitled master track',
  audio_url text,
  storage_path text,
  style text,
  prompt text,
  mastered_status text NOT NULL DEFAULT 'generating',
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT studio_tracks_status_check CHECK (mastered_status IN ('generating','ready','failed'))
);

CREATE INDEX studio_tracks_user_created_idx ON public.studio_tracks (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.studio_tracks TO authenticated;
GRANT ALL ON public.studio_tracks TO service_role;

ALTER TABLE public.studio_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own studio tracks"
  ON public.studio_tracks FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER studio_tracks_set_updated_at
  BEFORE UPDATE ON public.studio_tracks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();