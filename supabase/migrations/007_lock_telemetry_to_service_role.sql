-- supabase/migrations/007_lock_telemetry_to_service_role.sql

-- 1. Revoke public, anon, and authenticated permissions from telemetry table
REVOKE ALL ON TABLE public.pipeline_telemetry_logs FROM anon;
REVOKE ALL ON TABLE public.pipeline_telemetry_logs FROM authenticated;
REVOKE ALL ON TABLE public.pipeline_telemetry_logs FROM public;

-- 2. Drop any permissive read/write policies created previously
DROP POLICY IF EXISTS "Allow anon select on telemetry" ON public.pipeline_telemetry_logs;
DROP POLICY IF EXISTS "Allow authenticated select on telemetry" ON public.pipeline_telemetry_logs;
DROP POLICY IF EXISTS "Allow anon insert on telemetry" ON public.pipeline_telemetry_logs;
DROP POLICY IF EXISTS "Allow authenticated insert on telemetry" ON public.pipeline_telemetry_logs;
DROP POLICY IF EXISTS "Allow public read on telemetry" ON public.pipeline_telemetry_logs;
DROP POLICY IF EXISTS "Allow admin select on telemetry" ON public.pipeline_telemetry_logs;
DROP POLICY IF EXISTS "Allow service_role full access" ON public.pipeline_telemetry_logs;
DROP POLICY IF EXISTS "service_role_unrestricted_telemetry" ON public.pipeline_telemetry_logs;

-- Policies actually created by migration 006
DROP POLICY IF EXISTS "Anon read access to telemetry" ON public.pipeline_telemetry_logs;
DROP POLICY IF EXISTS "Service role full access to telemetry" ON public.pipeline_telemetry_logs;

-- 3. Force Row Level Security on the table
ALTER TABLE public.pipeline_telemetry_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_telemetry_logs FORCE ROW LEVEL SECURITY;

-- 4. Grant explicit table access only to service_role and postgres
GRANT ALL ON TABLE public.pipeline_telemetry_logs TO service_role;
GRANT ALL ON TABLE public.pipeline_telemetry_logs TO postgres;

-- 5. Create exclusive policy allowing only service_role full read/write access
CREATE POLICY "service_role_exclusive_access"
ON public.pipeline_telemetry_logs
FOR ALL
TO service_role
USING (auth.jwt() ->> 'role' = 'service_role' OR current_user = 'postgres')
WITH CHECK (auth.jwt() ->> 'role' = 'service_role' OR current_user = 'postgres');

-- 6. Ensure publication contains table for server-side SSE postgres_changes subscriptions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'pipeline_telemetry_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pipeline_telemetry_logs;
  END IF;
END $$;
