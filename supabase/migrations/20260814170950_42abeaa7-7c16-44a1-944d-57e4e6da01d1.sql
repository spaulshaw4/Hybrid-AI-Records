CREATE OR REPLACE FUNCTION public.admin_list_token_audit(
  email_filter text DEFAULT NULL,
  reason_filter text DEFAULT NULL,
  min_amount integer DEFAULT NULL,
  max_amount integer DEFAULT NULL,
  from_date timestamptz DEFAULT NULL,
  to_date timestamptz DEFAULT NULL,
  row_limit integer DEFAULT 200,
  acting_admin_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  email text,
  admin_email text,
  token_amount integer,
  reason text,
  balance_after integer,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  actor uuid := COALESCE(auth.uid(), acting_admin_id);
  lim integer := LEAST(GREATEST(COALESCE(row_limit, 200), 1), 500);
BEGIN
  IF actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = actor AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    l.id,
    l.user_id,
    u.email::text,
    a.email::text,
    l.token_amount,
    l.reason,
    l.balance_after,
    l.created_at
  FROM public.token_audit_log l
  LEFT JOIN auth.users u ON u.id = l.user_id
  LEFT JOIN auth.users a ON a.id = l.admin_id
  WHERE (email_filter IS NULL OR btrim(email_filter) = '' OR u.email ILIKE '%' || btrim(email_filter) || '%')
    AND (reason_filter IS NULL OR btrim(reason_filter) = '' OR COALESCE(l.reason, '') ILIKE '%' || btrim(reason_filter) || '%')
    AND (min_amount IS NULL OR l.token_amount >= min_amount)
    AND (max_amount IS NULL OR l.token_amount <= max_amount)
    AND (from_date IS NULL OR l.created_at >= from_date)
    AND (to_date IS NULL OR l.created_at <= to_date)
  ORDER BY l.created_at DESC
  LIMIT lim;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_list_token_audit(text, text, integer, integer, timestamptz, timestamptz, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_token_audit(text, text, integer, integer, timestamptz, timestamptz, integer, uuid) TO service_role;