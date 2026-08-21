CREATE TABLE IF NOT EXISTS public.token_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  kind text not null,
  reference text,
  note text,
  balance_after integer,
  created_at timestamptz not null default now()
);

GRANT SELECT ON public.token_ledger TO authenticated;
GRANT ALL ON public.token_ledger TO service_role;

ALTER TABLE public.token_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own token ledger"
  ON public.token_ledger FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Staff read all token ledger"
  ON public.token_ledger FOR SELECT TO authenticated
  USING (private.has_role(auth.uid(), 'admin'::public.app_role) OR private.has_role(auth.uid(), 'staff'::public.app_role));

CREATE UNIQUE INDEX IF NOT EXISTS token_ledger_reference_key
  ON public.token_ledger (reference) WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS token_ledger_user_created_idx
  ON public.token_ledger (user_id, created_at DESC);

INSERT INTO public.token_ledger (user_id, delta, kind, reference, note, created_at)
SELECT p.user_id, p.tokens, 'purchase', p.stripe_session_id, p.price_id, p.created_at
FROM public.token_purchases p
ON CONFLICT DO NOTHING;