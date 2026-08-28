-- supabase/migrations/002_audio_slices_genre.sql
-- Add genre column to audio_slices ledger for orchestrator filtering

-- 1. Add genre column with default value for existing records
ALTER TABLE audio_slices
ADD COLUMN genre TEXT DEFAULT 'unknown';

-- 2. Create index for rapid genre-based queries (critical for orchestrator bot)
CREATE INDEX idx_audio_slices_genre ON audio_slices(genre);
