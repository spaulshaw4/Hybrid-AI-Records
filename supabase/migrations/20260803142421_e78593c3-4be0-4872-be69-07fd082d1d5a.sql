-- Drafts are only ever reached through server functions that verify an owner
-- key or a hashed, expiring resume token. No client role should hold direct
-- Data API privileges on this table (defence in depth alongside deny-all RLS).
REVOKE ALL ON public.form_drafts FROM anon, authenticated;
GRANT ALL ON public.form_drafts TO service_role;