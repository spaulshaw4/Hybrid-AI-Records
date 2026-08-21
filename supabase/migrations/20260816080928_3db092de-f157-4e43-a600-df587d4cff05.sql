insert into public.v_token_balances (user_id, balance, updated_at)
values ('0369f3ad-2a9b-4ed4-94dc-9d9cad7bb7c2', 10, now())
on conflict (user_id) do update set balance = public.v_token_balances.balance + 10, updated_at = now();

insert into public.v_token_ledger (user_id, delta, kind, reference, note, balance_after)
select '0369f3ad-2a9b-4ed4-94dc-9d9cad7bb7c2', 10, 'grant', 'manual-grant', 'Manual grant of 10 V Tokens', balance
from public.v_token_balances where user_id = '0369f3ad-2a9b-4ed4-94dc-9d9cad7bb7c2';