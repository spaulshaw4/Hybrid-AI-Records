-- Replace the hand-built vocal_personas table (name text not null, no default)
-- with the columns the vocal routes write. Paste into the Supabase SQL Editor
-- for project cizvsurntyrrkhndzrpj. Does not drop public.tracks.

DROP TABLE IF EXISTS vocal_personas CASCADE;

CREATE TABLE IF NOT EXISTS public.vocal_personas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id text NOT NULL,
  user_id uuid NOT NULL,
  persona_id text,
  persona_name text,
  status text NOT NULL DEFAULT 'processing',
  error_message text,
  audio_url text,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE UNIQUE INDEX IF NOT EXISTS vocal_personas_task_id_uidx
  ON public.vocal_personas (task_id);

CREATE INDEX IF NOT EXISTS vocal_personas_user_id_idx
  ON public.vocal_personas (user_id);

ALTER TABLE public.vocal_personas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Artists read own vocal personas" ON public.vocal_personas;
CREATE POLICY "Artists read own vocal personas"
  ON public.vocal_personas
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON TABLE public.vocal_personas FROM PUBLIC;
REVOKE ALL ON TABLE public.vocal_personas FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.vocal_personas FROM authenticated;
GRANT SELECT ON TABLE public.vocal_personas TO authenticated;
GRANT ALL ON TABLE public.vocal_personas TO service_role;

-- public.tracks already exists. These columns let a song.failed callback
-- mark the matching row without inserting a master URL.
ALTER TABLE public.tracks
  ADD COLUMN IF NOT EXISTS task_id text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS error_message text;

CREATE INDEX IF NOT EXISTS tracks_task_id_idx
  ON public.tracks (task_id)
  WHERE task_id IS NOT NULL;
