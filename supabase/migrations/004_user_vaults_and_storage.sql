-- Enable pgvector extension for future vector-based audio feature indexing
create extension if not exists vector;

-- Create user_vaults ledger table for pipeline session tracking
create table if not exists user_vaults (
    id uuid default gen_random_uuid() primary key,
    session_id text unique not null,
    user_id text not null,
    genre_lock text not null,
    status text not null default 'pending', -- pending, processing, completed, failed
    master_hash text,
    storage_url text,
    metadata jsonb default '{}'::jsonb,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Ensure RLS is configured or disabled for service-role background workers
alter table user_vaults enable row level security;

create policy "Enable full access for service role" on user_vaults
    as permissive for all
    to service_role
    using (true)
    with check (true);

-- Create public storage bucket for master wav outputs
insert into storage.buckets (id, name, public)
values ('vault-storage', 'vault-storage', true)
on conflict (id) do nothing;

-- Storage bucket access policy for public read & authenticated/service write
create policy "Public Access to Master Renders"
    on storage.objects for select
    using ( bucket_id = 'vault-storage' );

create policy "Service Role Master Upload"
    on storage.objects for insert
    to service_role
    with check ( bucket_id = 'vault-storage' );
