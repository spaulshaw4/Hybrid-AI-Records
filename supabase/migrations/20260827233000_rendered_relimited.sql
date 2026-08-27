ALTER TABLE public.rendered_compositions
  ADD COLUMN IF NOT EXISTS relimited boolean NOT NULL DEFAULT false;
