ALTER TABLE public.vocal_session_requests
  ADD COLUMN original_request_id uuid REFERENCES public.vocal_session_requests(id) ON DELETE SET NULL,
  ADD COLUMN reschedule_round smallint NOT NULL DEFAULT 0;

CREATE INDEX vocal_session_requests_original_idx
  ON public.vocal_session_requests (original_request_id, reschedule_round);

CREATE OR REPLACE FUNCTION public.set_vocal_session_meeting_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  parent record;
begin
  if new.original_request_id is not null then
    select meeting_room, meeting_link, confirmed_slot, confirmed_at
      into parent
      from public.vocal_session_requests
     where id = new.original_request_id;
  end if;

  if parent.meeting_room is not null then
    -- A reschedule keeps the original booking's room and prior confirmation.
    new.meeting_room := parent.meeting_room;
    new.meeting_link := parent.meeting_link;
    new.confirmed_slot := parent.confirmed_slot;
    new.confirmed_at := parent.confirmed_at;
  else
    new.meeting_room := 'hybrid-' || lower(replace(gen_random_uuid()::text, '-', ''));
    new.meeting_link := 'https://meet.jit.si/' || new.meeting_room;
    new.confirmed_slot := null;
    new.confirmed_at := null;
  end if;

  return new;
end;
$function$;