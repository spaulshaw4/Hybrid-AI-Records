CREATE TABLE public.radio_settings (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  mix_style TEXT NOT NULL DEFAULT 'artist',
  shuffle BOOLEAN NOT NULL DEFAULT false,
  spacing INTEGER NOT NULL DEFAULT 1,
  mix_seed INTEGER NOT NULL DEFAULT 0,
  track_key TEXT,
  queue JSONB NOT NULL DEFAULT '[]'::jsonb,
  positions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.radio_settings TO authenticated;
GRANT ALL ON public.radio_settings TO service_role;

ALTER TABLE public.radio_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Listeners manage their own radio settings"
ON public.radio_settings FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER radio_settings_set_updated_at
BEFORE UPDATE ON public.radio_settings
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();