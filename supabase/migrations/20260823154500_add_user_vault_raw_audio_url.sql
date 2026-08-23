-- Gate 1 output (the engine's raw pre-master) kept alongside the mastered file
-- and stems so the vault can offer a pre-master export.
ALTER TABLE public.user_vault
  ADD COLUMN IF NOT EXISTS raw_audio_url text;

COMMENT ON COLUMN public.user_vault.raw_audio_url IS 'Raw Gate 1 engine audio before stem separation and mastering.';
