ALTER VIEW public.pricing_settings_public SET (security_invoker = off);
GRANT SELECT ON public.pricing_settings_public TO anon, authenticated;