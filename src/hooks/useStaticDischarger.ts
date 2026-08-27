/**
 * React hook for the Static Discharger — controlled bleed-off of session charge.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { dischargeSessionState } from "@/lib/static-charge";

export function useStaticDischarger() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const dischargeSessionStateFn = useCallback(
    async (options?: {
      aggressive?: boolean;
      redirectTo?: string | null;
      preserveReturnPath?: boolean;
      useHardRedirect?: boolean;
    }) => {
      const redirectTo = options?.redirectTo ?? "/";
      const useHardRedirect = options?.useHardRedirect !== false;

      await dischargeSessionState({
        signOut: true,
        aggressive: options?.aggressive ?? true,
        clearQueryClient: queryClient,
        preserveReturnPath: options?.preserveReturnPath ?? false,
        // Hard navigation purges in-memory router + React state; soft navigate as fallback.
        redirectTo: useHardRedirect ? redirectTo : null,
      });

      if (!useHardRedirect) {
        await navigate({ to: redirectTo as "/", replace: true });
      }
    },
    [navigate, queryClient],
  );

  return { dischargeSessionState: dischargeSessionStateFn };
}
