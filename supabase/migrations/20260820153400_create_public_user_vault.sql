-- Artist audio vault: one row per generate, with live status and stem URLs.
CREATE TABLE public.user_vault (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Untitled Track',
  style text,
  status text NOT NULL DEFAULT 'processing',
  master_url text,
  instrumental_url text,
  vocal_url text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT user_vault_status_check CHECK (status IN ('processing', 'completed', 'failed'))
);

COMMENT ON TABLE public.user_vault IS 'Per-artist generate vault: processing badge, mastered MP3, and stem downloads.';

CREATE INDEX user_vault_user_created_idx ON public.user_vault (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_vault TO authenticated;
GRANT ALL ON public.user_vault TO service_role;

ALTER TABLE public.user_vault ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Artists manage own vault rows"
  ON public.user_vault FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
