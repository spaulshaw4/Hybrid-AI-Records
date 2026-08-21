INSERT INTO public.token_balances (user_id, balance)
VALUES ('0369f3ad-2a9b-4ed4-94dc-9d9cad7bb7c2', 10)
ON CONFLICT (user_id) DO UPDATE
  SET balance = public.token_balances.balance + 10,
      updated_at = now();