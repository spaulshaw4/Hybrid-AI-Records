-- User Vaults table for tracking track generation status
-- Enables real-time WebSocket notifications when Python engine completes

CREATE TABLE IF NOT EXISTS user_vaults (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id TEXT UNIQUE NOT NULL,
    user_id UUID REFERENCES auth.users(id),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'error')),
    vault_path TEXT,
    genre TEXT,
    target_bpm INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Enable Row Level Security
ALTER TABLE user_vaults ENABLE ROW LEVEL SECURITY;

-- Users can only see their own vaults
CREATE POLICY "Users can view own vaults" ON user_vaults
    FOR SELECT USING (auth.uid() = user_id);

-- Service role can insert/update (for Python backend)
CREATE POLICY "Service role full access" ON user_vaults
    FOR ALL USING (auth.role() = 'service_role');

-- Enable realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE user_vaults;

-- Index for fast session lookups
CREATE INDEX idx_user_vaults_session ON user_vaults(session_id);
CREATE INDEX idx_user_vaults_user ON user_vaults(user_id);
CREATE INDEX idx_user_vaults_status ON user_vaults(status);

COMMENT ON TABLE user_vaults IS 'Tracks audio generation jobs and enables real-time status updates to frontend';
