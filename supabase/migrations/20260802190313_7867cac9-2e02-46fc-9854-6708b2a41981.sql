CREATE POLICY "Anyone can upload artist files"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'artist-uploads');