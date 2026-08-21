ALTER TABLE public.track_requests
  ADD COLUMN IF NOT EXISTS paid_session_id text,
  ADD COLUMN IF NOT EXISTS payment_state text NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS last_payment_session_id text,
  ADD COLUMN IF NOT EXISTS last_payment_attempt_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_payment_error text;

CREATE UNIQUE INDEX IF NOT EXISTS track_requests_paid_session_id_key
  ON public.track_requests (paid_session_id)
  WHERE paid_session_id IS NOT NULL;

UPDATE public.track_requests
  SET payment_state = 'paid'
  WHERE paid_at IS NOT NULL AND payment_state <> 'paid';