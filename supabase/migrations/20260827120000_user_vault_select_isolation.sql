-- Explicit SELECT isolation for Your Audio Vault (defense in depth).
-- Existing FOR ALL policy already scopes by auth.uid() = user_id; this named
-- SELECT policy documents the privacy contract for client RLS reads.

DROP POLICY IF EXISTS "Users can only view their own vault" ON public.user_vault;

CREATE POLICY "Users can only view their own vault"
  ON public.user_vault
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
