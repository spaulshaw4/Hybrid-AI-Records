ALTER TABLE public.track_requests
  ADD COLUMN IF NOT EXISTS payment_currency text,
  ADD COLUMN IF NOT EXISTS review_flag text,
  ADD COLUMN IF NOT EXISTS flag_details text,
  ADD COLUMN IF NOT EXISTS flagged_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS flag_resolved_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS flag_resolved_by uuid,
  ADD COLUMN IF NOT EXISTS flag_resolution_note text;

CREATE INDEX IF NOT EXISTS track_requests_review_flag_idx
  ON public.track_requests (review_flag)
  WHERE review_flag IS NOT NULL;