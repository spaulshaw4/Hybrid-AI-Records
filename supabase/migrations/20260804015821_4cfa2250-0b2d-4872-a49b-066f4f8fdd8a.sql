GRANT SELECT ON public.track_requests TO authenticated;
GRANT ALL ON public.track_requests TO service_role;
REVOKE ALL ON public.track_requests FROM anon;