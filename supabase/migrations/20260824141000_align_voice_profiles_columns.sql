-- Align public.voice_profiles with the studio voice library contract.
-- Safe on the live shape (id, user_id, name, sample_url, duration, quality_score, …)
-- and on the app shape (label, voice_id, quality analysis columns).

-- Core columns the saveVoiceProfile handler writes / selects.
ALTER TABLE public.voice_profiles
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS voice_id TEXT,
  ADD COLUMN IF NOT EXISTS peak double precision,
  ADD COLUMN IF NOT EXISTS rms double precision,
  ADD COLUMN IF NOT EXISTS clip_ratio double precision,
  ADD COLUMN IF NOT EXISTS silence_ratio double precision,
  ADD COLUMN IF NOT EXISTS clip_bars integer,
  ADD COLUMN IF NOT EXISTS silence_bars integer,
  ADD COLUMN IF NOT EXISTS total_bars integer,
  ADD COLUMN IF NOT EXISTS quality_blocked boolean,
  ADD COLUMN IF NOT EXISTS trim_start_seconds double precision;

-- Backfill label from legacy `name` when present.
UPDATE public.voice_profiles
SET label = name
WHERE label IS NULL AND name IS NOT NULL;

-- Empty / new rows: keep inserts working before NOT NULL is enforced.
UPDATE public.voice_profiles
SET label = COALESCE(label, 'Untitled voice')
WHERE label IS NULL;

UPDATE public.voice_profiles
SET voice_id = COALESCE(voice_id, 'voice_legacy_' || substr(replace(id::text, '-', ''), 1, 16))
WHERE voice_id IS NULL;

DO $$
BEGIN
  ALTER TABLE public.voice_profiles ALTER COLUMN label SET NOT NULL;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'label NOT NULL skipped: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE public.voice_profiles ALTER COLUMN voice_id SET NOT NULL;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'voice_id NOT NULL skipped: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE public.voice_profiles ALTER COLUMN sample_url SET NOT NULL;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'sample_url NOT NULL skipped: %', SQLERRM;
END $$;

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

NOTIFY pgrst, 'reload schema';
