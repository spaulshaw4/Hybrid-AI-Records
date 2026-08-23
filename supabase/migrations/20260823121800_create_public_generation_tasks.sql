-- Engine-side render tracking. `completeGenerationTask` already updates this
-- table, so without it those writes were silently swallowed as "table missing".
CREATE TABLE IF NOT EXISTS public.generation_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  audio_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.generation_tasks IS 'Engine render tasks: status plus the mastered audio URL once a render completes.';

CREATE INDEX IF NOT EXISTS idx_generation_tasks_user_created
  ON public.generation_tasks (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_tasks TO authenticated;
GRANT ALL ON public.generation_tasks TO service_role;

ALTER TABLE public.generation_tasks ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS, so drop first to keep re-runs idempotent.
DROP POLICY IF EXISTS "Users can view and manage their own generation tasks"
  ON public.generation_tasks;

CREATE POLICY "Users can view and manage their own generation tasks"
  ON public.generation_tasks
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
