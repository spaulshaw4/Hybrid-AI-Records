ALTER TABLE public.track_requests
  ADD COLUMN IF NOT EXISTS revision_request text,
  ADD COLUMN IF NOT EXISTS revision_updated_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS revision_round smallint NOT NULL DEFAULT 0;