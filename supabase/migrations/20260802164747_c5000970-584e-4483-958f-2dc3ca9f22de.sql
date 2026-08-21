CREATE TABLE public.application_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  artist text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  pkg text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  ack boolean NOT NULL DEFAULT false,
  saved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.application_drafts TO authenticated;
GRANT ALL ON public.application_drafts TO service_role;

ALTER TABLE public.application_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Artists manage their own application drafts"
ON public.application_drafts
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER application_drafts_set_updated_at
BEFORE UPDATE ON public.application_drafts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();