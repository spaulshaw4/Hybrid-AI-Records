ALTER TABLE public.fma_tracks
  ADD COLUMN IF NOT EXISTS drums_snr numeric(5, 2),
  ADD COLUMN IF NOT EXISTS bass_snr numeric(5, 2),
  ADD COLUMN IF NOT EXISTS vocals_snr numeric(5, 2),
  ADD COLUMN IF NOT EXISTS other_snr numeric(5, 2);
