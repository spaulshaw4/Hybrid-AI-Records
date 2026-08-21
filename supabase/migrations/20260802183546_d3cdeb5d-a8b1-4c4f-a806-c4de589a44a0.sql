ALTER TABLE public.track_requests
  ADD COLUMN IF NOT EXISTS locked_tier text,
  ADD COLUMN IF NOT EXISTS locked_turnaround_label text,
  ADD COLUMN IF NOT EXISTS locked_delivery_earliest timestamptz,
  ADD COLUMN IF NOT EXISTS locked_delivery_latest timestamptz,
  ADD COLUMN IF NOT EXISTS tier_locked_at timestamptz;