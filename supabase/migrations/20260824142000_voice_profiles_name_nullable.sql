-- Legacy voice_profiles.name is NOT NULL; the app writes `label`.
-- Keep name populated for old rows / dual-writers, but stop blocking inserts
-- that only set label (app code now mirrors name=label as well).

UPDATE public.voice_profiles
SET name = COALESCE(name, label, 'Untitled voice')
WHERE name IS NULL;

ALTER TABLE public.voice_profiles
  ALTER COLUMN name DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
