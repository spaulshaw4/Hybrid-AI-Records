CREATE TABLE public.index_coverage_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_url text NOT NULL,
  sitemap_total integer NOT NULL DEFAULT 0,
  indexed_count integer NOT NULL DEFAULT 0,
  not_indexed_count integer NOT NULL DEFAULT 0,
  unknown_count integer NOT NULL DEFAULT 0,
  sitemap_submitted integer NOT NULL DEFAULT 0,
  sitemap_indexed integer NOT NULL DEFAULT 0,
  pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX index_coverage_snapshots_captured_at_idx
  ON public.index_coverage_snapshots (site_url, captured_at DESC);

GRANT SELECT ON public.index_coverage_snapshots TO authenticated;
GRANT ALL ON public.index_coverage_snapshots TO service_role;

ALTER TABLE public.index_coverage_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read index coverage snapshots"
ON public.index_coverage_snapshots
FOR SELECT
TO authenticated
USING (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role));