REVOKE ALL ON FUNCTION public.credit_user_tokens(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_lookup_token_user(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_user_tokens(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_lookup_token_user(text) TO service_role;