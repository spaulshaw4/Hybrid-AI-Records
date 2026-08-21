import { useCallback, useEffect, useRef, useState } from "react";

import { readStoredVocalConsent } from "@/lib/vocal-consent";

/**
 * First custom-vocal click in a tab opens the liability modal.
 * Later clicks in the same session skip it.
 */
export function useVocalLiability(onAcceptedChange?: (accepted: boolean) => void) {
  const [accepted, setAccepted] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const next = readStoredVocalConsent();
    setAccepted(next);
    onAcceptedChange?.(next);
    // Parent callback is stable in practice; omit it to avoid re-sync loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runOrPrompt = useCallback(
    (action: () => void) => {
      if (readStoredVocalConsent()) {
        action();
        return;
      }
      pendingRef.current = action;
      setModalOpen(true);
    },
    [],
  );

  const handleAccepted = useCallback(() => {
    setAccepted(true);
    onAcceptedChange?.(true);
    const pending = pendingRef.current;
    pendingRef.current = null;
    pending?.();
  }, [onAcceptedChange]);

  const handleOpenChange = useCallback((open: boolean) => {
    setModalOpen(open);
    if (!open) pendingRef.current = null;
  }, []);

  return { accepted, modalOpen, runOrPrompt, handleAccepted, handleOpenChange };
}
