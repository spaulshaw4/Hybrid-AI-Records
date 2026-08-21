alter table public.vocal_session_requests
  add column if not exists meeting_room text,
  add column if not exists meeting_link text,
  add column if not exists confirmed_slot jsonb,
  add column if not exists confirmed_at timestamptz;

create or replace function public.set_vocal_session_meeting_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.meeting_room := 'hybrid-' || lower(replace(gen_random_uuid()::text, '-', ''));
  new.meeting_link := 'https://meet.jit.si/' || new.meeting_room;
  new.confirmed_slot := null;
  new.confirmed_at := null;
  return new;
end;
$$;

drop trigger if exists vocal_session_requests_meeting_link on public.vocal_session_requests;
create trigger vocal_session_requests_meeting_link
  before insert on public.vocal_session_requests
  for each row execute function public.set_vocal_session_meeting_link();

update public.vocal_session_requests
set meeting_room = 'hybrid-' || lower(replace(gen_random_uuid()::text, '-', ''))
where meeting_room is null;

update public.vocal_session_requests
set meeting_link = 'https://meet.jit.si/' || meeting_room
where meeting_link is null and meeting_room is not null;
