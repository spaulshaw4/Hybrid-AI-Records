REVOKE ALL ON FUNCTION public.spend_hybrid_tokens(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spend_hybrid_tokens(uuid, integer, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.redeem_artist_track_download(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_artist_track_download(uuid, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.credit_artist_token_purchase(uuid, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_artist_token_purchase(uuid, text, text, integer, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.credit_token_purchase(uuid, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_token_purchase(uuid, text, text, integer, integer, text) TO service_role;