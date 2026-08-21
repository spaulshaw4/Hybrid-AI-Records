import { useEffect, useState } from "react";
import { LogIn, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  clearSessionAndReauthenticate,
  SESSION_EXPIRED_EVENT,
} from "@/lib/session-auth";

export function SessionExpiredBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = () => setVisible(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, show);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, show);
  }, []);

  if (!visible) return null;
  return (
    <div className="fixed inset-x-4 top-4 z-[100] mx-auto max-w-xl" role="region" aria-label="Session expired">
      <Alert className="border-primary/60 bg-card/95 shadow-2xl backdrop-blur-md">
        <LogIn aria-hidden />
        <AlertTitle>Session Expired</AlertTitle>
        <AlertDescription>
          <p>Please log in again to continue your session. Your current form stays on screen until you continue.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void clearSessionAndReauthenticate()}>
              Re-authenticate / Log In
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setVisible(false)} aria-label="Dismiss session alert">
              <X aria-hidden />
              Dismiss
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}