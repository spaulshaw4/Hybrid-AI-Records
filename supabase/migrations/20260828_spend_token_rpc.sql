-- Hybrid Token Balance Table
CREATE TABLE IF NOT EXISTS user_balances (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) UNIQUE NOT NULL,
    token_balance DECIMAL(10, 2) DEFAULT 0.00,
    total_spent DECIMAL(10, 2) DEFAULT 0.00,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Token Transaction History
CREATE TABLE IF NOT EXISTS token_transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    transaction_type TEXT CHECK (transaction_type IN ('purchase', 'spend', 'refund')),
    session_id TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE user_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_transactions ENABLE ROW LEVEL SECURITY;

-- Users can view their own balance
CREATE POLICY "Users can view own balance" ON user_balances
    FOR SELECT USING (auth.uid() = user_id);

-- Users can view their own transactions
CREATE POLICY "Users can view own transactions" ON token_transactions
    FOR SELECT USING (auth.uid() = user_id);

-- Service role full access
CREATE POLICY "Service role balance access" ON user_balances
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role transaction access" ON token_transactions
    FOR ALL USING (auth.role() = 'service_role');

-- RPC Function: Spend Hybrid Token ($2.00)
CREATE OR REPLACE FUNCTION spend_hybrid_token(user_uuid UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    current_balance DECIMAL(10, 2);
    token_cost DECIMAL(10, 2) := 2.00;
BEGIN
    -- Get current balance
    SELECT token_balance INTO current_balance
    FROM user_balances
    WHERE user_id = user_uuid
    FOR UPDATE;

    -- Check if user has balance record
    IF current_balance IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Check if sufficient balance
    IF current_balance < token_cost THEN
        RETURN FALSE;
    END IF;

    -- Deduct token
    UPDATE user_balances
    SET 
        token_balance = token_balance - token_cost,
        total_spent = total_spent + token_cost,
        updated_at = NOW()
    WHERE user_id = user_uuid;

    -- Log transaction
    INSERT INTO token_transactions (user_id, amount, transaction_type, description)
    VALUES (user_uuid, -token_cost, 'spend', 'Hybrid Track Generation');

    RETURN TRUE;
END;
$$;

-- RPC Function: Add Tokens (for purchases)
CREATE OR REPLACE FUNCTION add_hybrid_tokens(user_uuid UUID, amount DECIMAL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Upsert balance
    INSERT INTO user_balances (user_id, token_balance)
    VALUES (user_uuid, amount)
    ON CONFLICT (user_id) DO UPDATE
    SET 
        token_balance = user_balances.token_balance + amount,
        updated_at = NOW();

    -- Log transaction
    INSERT INTO token_transactions (user_id, amount, transaction_type, description)
    VALUES (user_uuid, amount, 'purchase', 'Token Purchase');

    RETURN TRUE;
END;
$$;

-- Indexes
CREATE INDEX idx_user_balances_user ON user_balances(user_id);
CREATE INDEX idx_token_transactions_user ON token_transactions(user_id);
CREATE INDEX idx_token_transactions_created ON token_transactions(created_at DESC);

COMMENT ON FUNCTION spend_hybrid_token IS 'Deducts $2.00 for track generation, returns false if insufficient balance';
COMMENT ON FUNCTION add_hybrid_tokens IS 'Adds tokens to user balance after purchase';
