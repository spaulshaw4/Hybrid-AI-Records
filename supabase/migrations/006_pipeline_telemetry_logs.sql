-- Create pipeline_telemetry_logs table for hardware and execution metrics
CREATE TABLE IF NOT EXISTS pipeline_telemetry_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    event_type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    job_id TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Index for querying by event type and user
CREATE INDEX idx_telemetry_event_type ON pipeline_telemetry_logs(event_type);
CREATE INDEX idx_telemetry_user_id ON pipeline_telemetry_logs(user_id);
CREATE INDEX idx_telemetry_created_at ON pipeline_telemetry_logs(created_at DESC);

-- RLS for service role access
ALTER TABLE pipeline_telemetry_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to telemetry" ON pipeline_telemetry_logs
    AS PERMISSIVE FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Dashboard at /telemetry reads with the anon key
CREATE POLICY "Anon read access to telemetry" ON pipeline_telemetry_logs
    AS PERMISSIVE FOR SELECT
    TO anon, authenticated
    USING (true);

-- Enable Realtime for frontend status updates and the live telemetry feed
ALTER PUBLICATION supabase_realtime ADD TABLE user_vaults;
ALTER PUBLICATION supabase_realtime ADD TABLE pipeline_telemetry_logs;
