-- Ensure voice_profiles exists for the studio voice library.
-- Idempotent: safe to re-run on projects that already applied earlier migrations.

CREATE TABLE IF NOT EXISTS public.voice_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  label TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  sample_url TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  peak double precision,
  rms double precision,
  clip_ratio double precision,
  silence_ratio double precision,
  clip_bars integer,
  silence_bars integer,
  total_bars integer,
  quality_blocked boolean,
  trim_start_seconds double precision
);

ALTER TABLE public.voice_profiles
  ADD COLUMN IF NOT EXISTS peak double precision,
  ADD COLUMN IF NOT EXISTS rms double precision,
  ADD COLUMN IF NOT EXISTS clip_ratio double precision,
  ADD COLUMN IF NOT EXISTS silence_ratio double precision,
  ADD COLUMN IF NOT EXISTS clip_bars integer,
  ADD COLUMN IF NOT EXISTS silence_bars integer,
  ADD COLUMN IF NOT EXISTS total_bars integer,
  ADD COLUMN IF NOT EXISTS quality_blocked boolean,
  ADD COLUMN IF NOT EXISTS trim_start_seconds double precision;

CREATE INDEX IF NOT EXISTS voice_profiles_user_idx
  ON public.voice_profiles (user_id, created_at DESC);

ALTER TABLE public.voice_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Artists manage own voice profiles" ON public.voice_profiles;
CREATE POLICY "Artists manage own voice profiles"
  ON public.voice_profiles
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_profiles TO authenticated;
GRANT ALL ON public.voice_profiles TO service_role;

-- Force PostgREST to pick up the new table immediately.
NOTIFY pgrst, 'reload schema';
