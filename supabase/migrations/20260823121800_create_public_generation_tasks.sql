-- Engine-side render tracking. `completeGenerationTask` already updates this
-- table, so without it those writes were silently swallowed as "table missing".
CREATE TABLE public.generation_tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  audio_url text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT generation_tasks_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

COMMENT ON TABLE public.generation_tasks IS 'Engine render tasks: status plus the mastered audio URL once a render completes.';

CREATE INDEX generation_tasks_user_created_idx ON public.generation_tasks (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_tasks TO authenticated;
GRANT ALL ON public.generation_tasks TO service_role;

ALTER TABLE public.generation_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Artists manage own generation tasks"
  ON public.generation_tasks FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
