-- Migration: Complete Hybrid 1.0 Production Schema, Balances, Vaults, and RPC Ledger

-- 1. User Balances Table
create table if not exists public.user_balances (
    user_id uuid primary key,
    balance numeric(10, 2) not null default 0.00,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.user_balances enable row level security;

-- 2. Token Transactions Ledger Table
create table if not exists public.token_transactions (
    id uuid default gen_random_uuid() primary key,
    user_id uuid not null references public.user_balances(user_id) on delete cascade,
    amount numeric(10, 2) not null,
    transaction_type text not null check (transaction_type in ('credit', 'debit')),
    description text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.token_transactions enable row level security;

-- 3. User Vaults Table for Session Tracking & Realtime State
create table if not exists public.user_vaults (
    session_id text primary key,
    user_id uuid not null references public.user_balances(user_id) on delete cascade,
    status text not null check (status in ('processing', 'completed', 'failed')),
    vault_path text,
    metadata jsonb default '{}'::jsonb,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.user_vaults enable row level security;

-- Enable Realtime publication for user_vaults status updates
alter publication supabase_realtime add table public.user_vaults;

-- 4. Secure RPC Function for Token Deduction Transaction (default: $2.00)
create or replace function public.spend_hybrid_token(user_id_input uuid, amount numeric default 2.00)
returns boolean
language plpgsql
security definer
as $$
declare
    current_bal numeric;
begin
    -- Lock user balance row for atomic update
    select balance into current_bal
    from public.user_balances
    where user_id = user_id_input
    for update;

    -- If no balance record exists or insufficient funds, abort
    if not found or current_bal < amount then
        return false;
    end if;

    -- Deduct balance
    update public.user_balances
    set balance = balance - amount,
        updated_at = timezone('utc'::text, now())
    where user_id = user_id_input;

    -- Log transaction in ledger
    insert into public.token_transactions (user_id, amount, transaction_type, description)
    values (user_id_input, amount, 'debit', 'Hybrid 1.0 Generation Fee');

    return true;
end;
$$;
