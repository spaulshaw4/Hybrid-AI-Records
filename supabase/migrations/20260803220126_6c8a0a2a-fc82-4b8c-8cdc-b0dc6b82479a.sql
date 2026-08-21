create or replace function public.set_vocal_session_meeting_link()
returns trigger
language plpgsql
security invoker
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

revoke all on function public.set_vocal_session_meeting_link() from public, anon, authenticated;
