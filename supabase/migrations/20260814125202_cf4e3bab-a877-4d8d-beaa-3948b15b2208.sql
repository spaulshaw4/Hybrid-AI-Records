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