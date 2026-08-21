CREATE TABLE public.engine_proxy_cache (
  fingerprint TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.engine_proxy_cache TO service_role;

ALTER TABLE public.engine_proxy_cache ENABLE ROW LEVEL SECURITY;

CREATE INDEX engine_proxy_cache_expires_at_idx ON public.engine_proxy_cache (expires_at);

CREATE TRIGGER engine_proxy_cache_set_updated_at
BEFORE UPDATE ON public.engine_proxy_cache
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();