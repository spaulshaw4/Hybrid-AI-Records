-- supabase/migrations/002_audio_slices_genre.sql
-- Slice ledger written by batch_slicer_upload.py and read by
-- cylinder_orchestrator.py / ai_inference_engine.py.
--
-- This migration previously only ran ALTER TABLE audio_slices, but no migration
-- ever created the table, so it failed and every slice insert 404'd. It now
-- creates the table if absent and is safe to re-run against a database where an
-- earlier version already created it.

CREATE TABLE IF NOT EXISTS public.audio_slices (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    original_file TEXT,
    slice_index INTEGER,
    hash TEXT,
    genre TEXT DEFAULT 'unknown',
    status TEXT DEFAULT 'archived',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Present for databases where the table pre-existed without the column
ALTER TABLE public.audio_slices
ADD COLUMN IF NOT EXISTS genre TEXT DEFAULT 'unknown';

-- The orchestrator filters on genre for every render, and de-dupes on filename
CREATE INDEX IF NOT EXISTS idx_audio_slices_genre ON public.audio_slices(genre);
CREATE INDEX IF NOT EXISTS idx_audio_slices_filename ON public.audio_slices(filename);
CREATE INDEX IF NOT EXISTS idx_audio_slices_hash ON public.audio_slices(hash);

ALTER TABLE public.audio_slices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to audio_slices" ON public.audio_slices;
CREATE POLICY "Service role full access to audio_slices"
ON public.audio_slices
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
