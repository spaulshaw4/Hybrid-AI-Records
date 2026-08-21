create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('token_credit','token_refund','generation_failed')),
  title text not null,
  body text not null,
  reference text,
  emailed boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_user_created_idx
  on public.user_notifications (user_id, created_at desc);

grant select, update on public.user_notifications to authenticated;
grant all on public.user_notifications to service_role;

alter table public.user_notifications enable row level security;

drop policy if exists "Users read own notifications" on public.user_notifications;
create policy "Users read own notifications"
  on public.user_notifications for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users mark own notifications read" on public.user_notifications;
create policy "Users mark own notifications read"
  on public.user_notifications for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);