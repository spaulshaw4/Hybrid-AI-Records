-- Vault catalog relations: artists + albums, FKs on user_vault for PostgREST embeds.
-- Enables: select('*, album:albums(*), artist:artists(*)')

CREATE TABLE IF NOT EXISTS public.artists (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.albums (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  artist_id uuid REFERENCES public.artists(id) ON DELETE SET NULL,
  name text NOT NULL,
  cover_url text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS artists_user_name_idx ON public.artists (user_id, name);
CREATE INDEX IF NOT EXISTS albums_user_artist_idx ON public.albums (user_id, artist_id, name);

ALTER TABLE public.user_vault
  ADD COLUMN IF NOT EXISTS artist_id uuid REFERENCES public.artists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS album_id uuid REFERENCES public.albums(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS artist_name text,
  ADD COLUMN IF NOT EXISTS album_name text;

CREATE INDEX IF NOT EXISTS user_vault_album_idx ON public.user_vault (album_id);
CREATE INDEX IF NOT EXISTS user_vault_artist_idx ON public.user_vault (artist_id);

COMMENT ON TABLE public.artists IS 'Per-user artist identity for vault catalog grouping.';
COMMENT ON TABLE public.albums IS 'Per-user albums linked to artists for vault embeds.';
COMMENT ON COLUMN public.user_vault.artist_name IS 'Denormalized artist label for grouping when relation is unset.';
COMMENT ON COLUMN public.user_vault.album_name IS 'Denormalized album label for grouping when relation is unset.';

ALTER TABLE public.artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.albums ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Artists manage own artist rows" ON public.artists;
CREATE POLICY "Artists manage own artist rows"
  ON public.artists FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Artists manage own album rows" ON public.albums;
CREATE POLICY "Artists manage own album rows"
  ON public.albums FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.artists TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.albums TO authenticated;
GRANT ALL ON public.artists TO service_role;
GRANT ALL ON public.albums TO service_role;
