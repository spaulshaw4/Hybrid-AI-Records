-- Local migration only. Do not apply this against the remote database from the app.
-- Adds the D-Token balance used by POST /api/distribute/too-lost.
-- profiles has no full_name column; legal-name defaults read display_name.
-- The primary key is user_id (there is no profiles.id in this schema).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS d_tokens integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.profiles.d_tokens IS
  'Distribution tokens. Decrement by 1 only after Too Lost returns HTTP 200 or 201 with a release id.';
