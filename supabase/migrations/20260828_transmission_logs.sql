-- Migration: Add transmission support tables & tracking indices

create table if not exists public.transmission_logs (
    id uuid default gen_random_uuid() primary key,
    session_id text not null references public.user_vaults(session_id) on delete cascade,
    transmission_status text not null check (transmission_status in ('buffered', 'streaming', 'exported')),
    buffer_samples integer not null default 256,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on transmission logs
alter table public.transmission_logs enable row level security;

-- Index for fast session transmission lookups
create index if not exists idx_transmission_logs_session on public.transmission_logs(session_id);
