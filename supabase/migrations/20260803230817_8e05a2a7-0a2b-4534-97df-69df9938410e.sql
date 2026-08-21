ALTER TABLE public.session_email_log REPLICA IDENTITY FULL;
ALTER TABLE public.vocal_session_requests REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.session_email_log;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vocal_session_requests;