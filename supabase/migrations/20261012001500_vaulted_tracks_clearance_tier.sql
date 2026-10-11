-- Finished songs are stored on vaulted_tracks. public.tracks is still written
-- by the legacy stem catalog, so the same column is added there too.

ALTER TABLE public.vaulted_tracks
  ADD COLUMN IF NOT EXISTS clearance_tier VARCHAR(20) DEFAULT 'ai_voice';

ALTER TABLE public.tracks
  ADD COLUMN IF NOT EXISTS clearance_tier VARCHAR(20) DEFAULT 'ai_voice';
