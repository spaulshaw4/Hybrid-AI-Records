-- Store MusicAPI / AIMusicAPI task ids on the client-opened vault row so
-- composition can register pending work immediately (task ids are often not UUIDs).
ALTER TABLE public.user_vault
  ADD COLUMN IF NOT EXISTS provider_task_id text;

COMMENT ON COLUMN public.user_vault.provider_task_id IS
  'Upstream Sonic / MusicAPI task id for an in-flight composition job.';

CREATE INDEX IF NOT EXISTS user_vault_provider_task_id_idx
  ON public.user_vault (provider_task_id)
  WHERE provider_task_id IS NOT NULL;
