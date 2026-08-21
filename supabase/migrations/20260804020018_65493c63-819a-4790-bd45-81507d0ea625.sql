GRANT SELECT, UPDATE ON public.form_drafts TO authenticated;
GRANT ALL ON public.form_drafts TO service_role;
REVOKE ALL ON public.form_drafts FROM anon;