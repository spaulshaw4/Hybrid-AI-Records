GRANT SELECT ON public.track_requests TO authenticated;

CREATE POLICY "Staff can read track requests"
  ON public.track_requests
  FOR SELECT
  TO authenticated
  USING (
    private.has_role(auth.uid(), 'admin'::app_role)
    OR private.has_role(auth.uid(), 'staff'::app_role)
  );