GRANT SELECT ON public.form_drafts TO authenticated;
GRANT ALL ON public.form_drafts TO service_role;

CREATE POLICY "Staff can read form drafts"
ON public.form_drafts
FOR SELECT
TO authenticated
USING (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role));