CREATE TABLE public.token_balances (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.token_balances TO authenticated;
GRANT ALL ON public.token_balances TO service_role;
ALTER TABLE public.token_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own token balance" ON public.token_balances FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER token_balances_set_updated_at BEFORE UPDATE ON public.token_balances FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.token_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_session_id text NOT NULL UNIQUE,
  price_id text NOT NULL,
  tokens integer NOT NULL,
  amount_total integer,
  currency text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_token_purchases_user ON public.token_purchases(user_id);
GRANT SELECT ON public.token_purchases TO authenticated;
GRANT ALL ON public.token_purchases TO service_role;
ALTER TABLE public.token_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own token purchases" ON public.token_purchases FOR SELECT TO authenticated USING (auth.uid() = user_id);