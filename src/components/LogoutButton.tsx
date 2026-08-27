import { useState } from "react";
import { LogOut } from "lucide-react";
import { useStaticDischarger } from "@/hooks/useStaticDischarger";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type LogoutButtonProps = {
  className?: string;
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "sm" | "lg" | "icon";
  /** Where to land after discharge (default `/auth`). */
  redirectTo?: string;
  children?: React.ReactNode;
};

/**
 * Logout control wired to the Static Discharger:
 * terminates auth, clears user-scoped caches, and hard-redirects so no residual
 * session charge bleeds into the next login on a shared device.
 */
export function LogoutButton({
  className,
  variant = "destructive",
  size = "default",
  redirectTo = "/auth",
  children,
}: LogoutButtonProps) {
  const { dischargeSessionState } = useStaticDischarger();
  const [isDischarging, setIsDischarging] = useState(false);

  const handleLogout = async () => {
    try {
      setIsDischarging(true);
      await dischargeSessionState({
        aggressive: true,
        redirectTo,
        useHardRedirect: true,
      });
    } catch (err) {
      console.error("Logout discharge failed:", err);
      setIsDischarging(false);
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn(className)}
      onClick={() => void handleLogout()}
      disabled={isDischarging}
      aria-busy={isDischarging}
    >
      <LogOut className="size-4" aria-hidden />
      {isDischarging ? "Discharging Session…" : children ?? "Log Out"}
    </Button>
  );
}
