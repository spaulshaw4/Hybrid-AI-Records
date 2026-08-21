CREATE TABLE public.translation_overrides (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  language text NOT NULL,
  source_text text NOT NULL,
  translated_text text NOT NULL,
  updated_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (language, source_text)
);

GRANT SELECT ON public.translation_overrides TO anon;
GRANT SELECT ON public.translation_overrides TO authenticated;
GRANT ALL ON public.translation_overrides TO service_role;

ALTER TABLE public.translation_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read translation overrides"
ON public.translation_overrides FOR SELECT TO anon, authenticated USING (true);

CREATE INDEX translation_overrides_language_idx ON public.translation_overrides (language);

CREATE TRIGGER translation_overrides_set_updated_at
BEFORE UPDATE ON public.translation_overrides
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();