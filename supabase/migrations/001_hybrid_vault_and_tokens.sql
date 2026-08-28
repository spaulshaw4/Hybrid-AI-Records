-- supabase/migrations/001_hybrid_vault_and_tokens.sql

-- 1. Token Balances Table (3-Tier System)
CREATE TABLE user_token_balances (
    user_id UUID REFERENCES auth.users(id) PRIMARY KEY,
    tier_1_tokens INTEGER DEFAULT 0, -- $1.00 tokens (Standard)
    hybrid_tokens INTEGER DEFAULT 0, -- $2.00 tokens (Hybrid Creation)
    tier_3_tokens INTEGER DEFAULT 0, -- $30.00 tokens (Pro/Video Render)
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. User Vaults Table (Session & Cryptographic Tracking)
CREATE TABLE user_vaults (
    session_id TEXT PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id),
    status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
    genre_lock TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Atomic RPC Transaction: Deduct $2.00 Hybrid Token & Initialize Vault
CREATE OR REPLACE FUNCTION spend_hybrid_token_and_create_session(
    p_user_id UUID,
    p_session_id TEXT,
    p_genre_lock TEXT,
    p_metadata JSONB
) RETURNS BOOLEAN AS $$
DECLARE
    current_hybrid_tokens INTEGER;
BEGIN
    -- Lock row for update to prevent concurrent double-spending race conditions
    SELECT hybrid_tokens INTO current_hybrid_tokens
    FROM user_token_balances
    WHERE user_id = p_user_id
    FOR UPDATE;

    -- Verify the $2.00 token balance
    IF current_hybrid_tokens IS NULL OR current_hybrid_tokens < 1 THEN
        RETURN FALSE; -- Insufficient Hybrid Tokens
    END IF;

    -- Deduct EXACTLY one hybrid token
    UPDATE user_token_balances
    SET hybrid_tokens = hybrid_tokens - 1,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- Register the session in the vault ledger for the local worker daemon
    INSERT INTO user_vaults (session_id, user_id, status, genre_lock, metadata)
    VALUES (p_session_id, p_user_id, 'pending', p_genre_lock, p_metadata);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
