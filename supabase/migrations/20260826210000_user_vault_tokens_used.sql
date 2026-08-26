-- Persist Hybrid Token spend on each vault generation row.
ALTER TABLE public.user_vault
  ADD COLUMN IF NOT EXISTS tokens_used integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.user_vault.tokens_used IS
  'Hybrid Tokens charged for this generation (usually 1).';

ALTER TABLE public.user_vault
  DROP CONSTRAINT IF EXISTS user_vault_tokens_used_check;

ALTER TABLE public.user_vault
  ADD CONSTRAINT user_vault_tokens_used_check CHECK (tokens_used >= 0 AND tokens_used <= 100);
