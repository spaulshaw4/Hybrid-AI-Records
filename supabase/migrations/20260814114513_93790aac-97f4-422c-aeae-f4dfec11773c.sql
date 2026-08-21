CREATE POLICY "Artists upload own voice samples" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'voice-samples' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Artists read own voice samples" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'voice-samples' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Artists delete own voice samples" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'voice-samples' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE TABLE public.voice_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  label TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  sample_url TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_profiles TO authenticated;
GRANT ALL ON public.voice_profiles TO service_role;
ALTER TABLE public.voice_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Artists manage own voice profiles" ON public.voice_profiles FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX voice_profiles_user_idx ON public.voice_profiles (user_id, created_at DESC);