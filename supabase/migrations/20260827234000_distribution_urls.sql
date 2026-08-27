ALTER TABLE public.rendered_compositions
  ADD COLUMN IF NOT EXISTS master_wav_url text,
  ADD COLUMN IF NOT EXISTS master_mp3_url text,
  ADD COLUMN IF NOT EXISTS master_aac_url text;

ALTER TABLE public.fma_tracks
  ADD COLUMN IF NOT EXISTS master_wav_url text,
  ADD COLUMN IF NOT EXISTS master_mp3_url text,
  ADD COLUMN IF NOT EXISTS master_aac_url text;

COMMENT ON COLUMN public.rendered_compositions.master_wav_url IS
  'Public CDN URL for the mastered WAV. Mix jobs live here, not on fma_tracks.';
