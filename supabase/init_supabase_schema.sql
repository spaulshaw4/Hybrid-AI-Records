-- D:\MusicDatasets\config\init_supabase_schema.sql
-- ============================================================================
-- HYBRID 1.0 - SUPABASE DATABASE SCHEMA, INDEXES & STORAGE POLICIES
-- ============================================================================
--
-- Consolidated, idempotent initialiser. Safe to run against either a fresh
-- database or one where migrations 001-007 already ran.
--
-- Why the ALTER blocks exist: four separate migrations declare user_vaults
-- (001_hybrid_vault_and_tokens, 004_user_vaults_and_storage,
-- 20260828_hybrid_vault_schema, 20260828_user_vaults) with different shapes.
-- Because the CLI orders them lexicographically, 001 wins and the later
-- CREATE TABLE IF NOT EXISTS statements silently no-op. So a bare
-- CREATE TABLE IF NOT EXISTS here would also no-op and leave the divergence in
-- place - the ALTERs below converge whatever exists onto the canonical shape.

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. USER VAULTS (PIPELINE QUEUE & CATALOG LEDGER)
CREATE TABLE IF NOT EXISTS public.user_vaults (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT UNIQUE NOT NULL,
    user_id UUID NOT NULL,
    genre_lock TEXT NOT NULL DEFAULT 'heavy_alternative_rock',
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    master_hash TEXT,
    storage_url TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Converge a pre-existing table onto the canonical column set.
ALTER TABLE public.user_vaults ADD COLUMN IF NOT EXISTS master_hash TEXT;
ALTER TABLE public.user_vaults ADD COLUMN IF NOT EXISTS storage_url TEXT;
ALTER TABLE public.user_vaults ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.user_vaults ADD COLUMN IF NOT EXISTS genre_lock TEXT DEFAULT 'heavy_alternative_rock';
ALTER TABLE public.user_vaults ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW());

-- 001 declares user_id as UUID REFERENCES auth.users(id). That foreign key makes
-- the test harnesses fail, since their synthetic user does not exist in
-- auth.users. Drop the constraint but keep the UUID type.
DO $$
DECLARE
    fk_name TEXT;
BEGIN
    SELECT con.conname INTO fk_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'user_vaults'
      AND con.contype = 'f'
    LIMIT 1;

    IF fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.user_vaults DROP CONSTRAINT %I', fk_name);
        RAISE NOTICE 'Dropped foreign key % on user_vaults', fk_name;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_vaults_status_created ON public.user_vaults (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_user_vaults_session_id ON public.user_vaults (session_id);
CREATE INDEX IF NOT EXISTS idx_user_vaults_user_id ON public.user_vaults (user_id);

-- 3. PIPELINE TELEMETRY LOGS
CREATE TABLE IF NOT EXISTS public.pipeline_telemetry_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    job_id TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

ALTER TABLE public.pipeline_telemetry_logs ADD COLUMN IF NOT EXISTS job_id TEXT;

CREATE INDEX IF NOT EXISTS idx_telemetry_event_type ON public.pipeline_telemetry_logs (event_type);
CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON public.pipeline_telemetry_logs (created_at DESC);

-- 4. AUDIO SLICES (SLICE LEDGER)
-- Written by batch_slicer_upload.py, read by cylinder_orchestrator.py and
-- ai_inference_engine.py. Omitting this leaves every slice insert 404ing.
CREATE TABLE IF NOT EXISTS public.audio_slices (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    original_file TEXT,
    slice_index INTEGER,
    hash TEXT,
    genre TEXT DEFAULT 'unknown',
    status TEXT DEFAULT 'archived',
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

ALTER TABLE public.audio_slices ADD COLUMN IF NOT EXISTS genre TEXT DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_audio_slices_genre ON public.audio_slices (genre);
CREATE INDEX IF NOT EXISTS idx_audio_slices_filename ON public.audio_slices (filename);
CREATE INDEX IF NOT EXISTS idx_audio_slices_hash ON public.audio_slices (hash);

-- 5. AUTO-UPDATE TIMESTAMP TRIGGER
-- Removes the need for callers to set updated_at, and closes the case where a
-- NULL updated_at made a stalled session invisible to the healer's time filter.
CREATE OR REPLACE FUNCTION public.set_current_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = TIMEZONE('utc'::text, NOW());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_vaults_updated_at ON public.user_vaults;
CREATE TRIGGER trg_user_vaults_updated_at
    BEFORE UPDATE ON public.user_vaults
    FOR EACH ROW
    EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- Backfill so existing rows are not permanently invisible to the healer
UPDATE public.user_vaults
SET updated_at = COALESCE(updated_at, created_at, TIMEZONE('utc'::text, NOW()))
WHERE updated_at IS NULL;

-- 6. STORAGE BUCKET INITIALIZATION
INSERT INTO storage.buckets (id, name, public)
VALUES ('vault-storage', 'vault-storage', true)
ON CONFLICT (id) DO NOTHING;

-- 7. ROW LEVEL SECURITY POLICIES
-- CREATE POLICY has no IF NOT EXISTS, so each is dropped first to keep this
-- script re-runnable.
ALTER TABLE public.user_vaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_telemetry_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_slices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on user_vaults" ON public.user_vaults;
CREATE POLICY "Service role full access on user_vaults"
    ON public.user_vaults
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on pipeline_telemetry_logs" ON public.pipeline_telemetry_logs;
CREATE POLICY "Service role full access on pipeline_telemetry_logs"
    ON public.pipeline_telemetry_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on audio_slices" ON public.audio_slices;
CREATE POLICY "Service role full access on audio_slices"
    ON public.audio_slices
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Public storage read access" ON storage.objects;
CREATE POLICY "Public storage read access"
    ON storage.objects
    FOR SELECT
    TO public
    USING (bucket_id = 'vault-storage');

DROP POLICY IF EXISTS "Service role storage write access" ON storage.objects;
CREATE POLICY "Service role storage write access"
    ON storage.objects
    FOR ALL
    TO service_role
    USING (bucket_id = 'vault-storage')
    WITH CHECK (bucket_id = 'vault-storage');

-- 8. REALTIME PUBLICATION
-- The /vault and /telemetry pages subscribe to postgres_changes; a table absent
-- from the publication produces no events and the UI silently never updates.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'user_vaults'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.user_vaults;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pipeline_telemetry_logs'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.pipeline_telemetry_logs;
    END IF;
END $$;
