-- Voice enrollment profile, Stripe event receipts, and permanent generate masters.
-- Does not drop unrelated tables or rewrite the live catalog.

CREATE TABLE IF NOT EXISTS public.artist_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  vocal_id text,
  is_voice_enrolled boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.vaulted_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  prompt text,
  lyrics text,
  vocal_id_used text,
  wav_url text NOT NULL,
  mp3_url text NOT NULL,
  task_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS vaulted_tracks_user_created_idx
  ON public.vaulted_tracks (user_id, created_at DESC);

ALTER TABLE public.artist_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vaulted_tracks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Artists read own voice profile" ON public.artist_profiles;
CREATE POLICY "Artists read own voice profile"
  ON public.artist_profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Artists read own vaulted tracks" ON public.vaulted_tracks;
CREATE POLICY "Artists read own vaulted tracks"
  ON public.vaulted_tracks
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT ON public.artist_profiles TO authenticated;
GRANT SELECT ON public.vaulted_tracks TO authenticated;
GRANT ALL ON public.artist_profiles TO service_role;
GRANT ALL ON public.stripe_webhook_events TO service_role;
GRANT ALL ON public.vaulted_tracks TO service_role;
