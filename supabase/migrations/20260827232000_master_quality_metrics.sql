ALTER TABLE public.fma_tracks
  ADD COLUMN IF NOT EXISTS integrated_lufs numeric(5, 2),
  ADD COLUMN IF NOT EXISTS true_peak_dbfs numeric(5, 2),
  ADD COLUMN IF NOT EXISTS sample_rate integer DEFAULT 44100,
  ADD COLUMN IF NOT EXISTS mastered_at timestamptz;

CREATE TABLE IF NOT EXISTS public.rendered_compositions (
  job_id text PRIMARY KEY,
  r2_key text,
  target_bpm double precision,
  status text NOT NULL DEFAULT 'completed',
  integrated_lufs numeric(5, 2),
  true_peak_dbfs numeric(5, 2),
  sample_rate integer DEFAULT 44100,
  mastered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

COMMENT ON TABLE public.rendered_compositions IS 'Celery mix jobs with post-master LUFS / true-peak QC.';

GRANT SELECT ON public.rendered_compositions TO authenticated;
GRANT ALL ON public.rendered_compositions TO service_role;

ALTER TABLE public.rendered_compositions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read rendered compositions"
  ON public.rendered_compositions FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Allow service role full access on rendered_compositions" ON public.rendered_compositions;
CREATE POLICY "Allow service role full access on rendered_compositions"
  ON public.rendered_compositions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
