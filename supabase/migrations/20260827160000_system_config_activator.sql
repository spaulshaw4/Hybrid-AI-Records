-- Master Activator Switch config (pipeline_master_state: ARMED | MAINTENANCE | DISABLED).

CREATE TABLE IF NOT EXISTS public.system_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

COMMENT ON TABLE public.system_config IS
  'Global runtime flags (Pipeline Activator Switch, feature arms). Service-role writes only.';

ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.system_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.system_config TO service_role;

INSERT INTO public.system_config (key, value)
VALUES ('pipeline_master_state', 'ARMED')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.system_config_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS system_config_set_updated_at ON public.system_config;
CREATE TRIGGER system_config_set_updated_at
  BEFORE UPDATE ON public.system_config
  FOR EACH ROW
  EXECUTE FUNCTION public.system_config_set_updated_at();
