import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { retryFailedSessionEmail } from "@/lib/session-email-retry.functions";
import type { SessionEmailEntry } from "@/lib/session-email-log.functions";

/**
 * Staff "retry delivery" control for a failed notification. Always asks for
 * confirmation first, and surfaces the server-side rate limits (per-session
 * cooldown + global burst guard) as plain messages.
 */
export function RetryEmailButton({
  entry,
  onRetried,
  className,
}: {
  entry: SessionEmailEntry;
  onRetried?: () => void;
  className?: string;
}) {
  const retry = useServerFn(retryFailedSessionEmail);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  function startCooldown(seconds: number) {
    setCooldown(seconds);
    const timer = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          clearInterval(timer);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  async function run() {
    setBusy(true);
    try {
      const result = (await retry({ data: { emailId: entry.id } })) as {
        ok: boolean;
        reason?: string;
        retryInSeconds?: number;
        recipient?: string;
        cooldownSeconds?: number;
      };
      if (result.ok) {
        toast.success(`Delivery retried — resent to ${result.recipient ?? entry.recipient}`);
        startCooldown(result.cooldownSeconds ?? 90);
        onRetried?.();
      } else if (result.reason === "cooldown") {
        toast.error(`Too soon — wait ${result.retryInSeconds ?? 90}s before retrying this session.`);
        startCooldown(result.retryInSeconds ?? 90);
      } else if (result.reason === "rate_limited") {
        toast.error("Retry limit reached for the last 10 minutes. Try again shortly.");
        startCooldown(result.retryInSeconds ?? 600);
      } else if (result.reason === "already_sent") {
        toast.info("That notification already delivered successfully.");
        onRetried?.();
      } else {
        toast.error(`Retry failed: ${result.reason ?? "unknown error"}`);
        onRetried?.();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  const disabled = busy || cooldown > 0;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={
          className ??
          "inline-flex items-center gap-1.5 border border-[#e11d2e]/60 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[#e11d2e] transition-colors hover:bg-[#e11d2e]/10 disabled:opacity-50"
        }
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <RotateCcw className="h-3 w-3" />
        )}
        {cooldown > 0 ? `Retry in ${cooldown}s` : "Retry delivery"}
      </button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry this delivery?</AlertDialogTitle>
            <AlertDialogDescription>
              This resends “{entry.subject}” to {entry.recipient}. Retries are limited to one per
              session every 90 seconds and 10 across the inbox every 10 minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              {busy ? "Sending…" : "Retry delivery"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
