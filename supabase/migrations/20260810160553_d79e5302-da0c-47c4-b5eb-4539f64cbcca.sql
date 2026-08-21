CREATE POLICY "Staff read studio deliveries"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'studio-deliveries' AND (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role)));

CREATE POLICY "Staff write studio deliveries"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'studio-deliveries' AND (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role)));

CREATE POLICY "Staff update studio deliveries"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'studio-deliveries' AND (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role)))
WITH CHECK (bucket_id = 'studio-deliveries' AND (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role)));

CREATE POLICY "Staff delete studio deliveries"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'studio-deliveries' AND (private.has_role(auth.uid(), 'admin'::app_role) OR private.has_role(auth.uid(), 'staff'::app_role)));