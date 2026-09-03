-- Idempotent column addition
ALTER TABLE public.user_vault
ADD COLUMN IF NOT EXISTS instrumental_url TEXT;

-- Reload PostgREST schema cache immediately
NOTIFY pgrst, 'reload schema';
