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
import { Button } from "@/components/ui/button";
import { retryFailedSessionEmail } from "@/lib/session-email-retry.functions";
import type { SessionInboxRow } from "@/lib/session-email-log.functions";

type RetryResult = {
  ok: boolean;
  reason?: string;
  retryInSeconds?: number;
  recipient?: string;
};

/**
 * One-click "resend all failures" for exactly the rows currently in view
 * (active filters + the selected export scope). Runs sequentially so the
 * server-side rate limits behave predictably, and stops early once the
 * inbox-wide burst guard trips.
 */
export function BulkRetryButton({
  rows,
  scopeLabel,
  onRetried,
}: {
  rows: SessionInboxRow[];
  scopeLabel: string;
  onRetried?: () => void;
}) {
  const retry = useServerFn(retryFailedSessionEmail);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const failed = rows.flatMap((row) => row.emails.filter((e) => e.outcome !== "sent"));
  const total = failed.length;

  async function run() {
    setBusy(true);
    setProgress(0);
    let sent = 0;
    let skipped = 0;
    let stopped = false;

    try {
      for (const [index, entry] of failed.entries()) {
        setProgress(index + 1);
        let result: RetryResult;
        try {
          result = (await retry({ data: { emailId: entry.id } })) as RetryResult;
        } catch (err) {
          skipped += 1;
          console.error("Bulk retry failed for", entry.id, err);
          continue;
        }
        if (result.ok) {
          sent += 1;
        } else if (result.reason === "rate_limited") {
          stopped = true;
          break;
        } else {
          skipped += 1;
        }
      }

      if (sent > 0) {
        toast.success(
          `Resent ${sent} of ${total} failed ${total === 1 ? "email" : "emails"}${
            skipped > 0 ? ` · ${skipped} skipped` : ""
          }`,
        );
      } else if (!stopped) {
        toast.error("No emails could be resent — all attempts were skipped or rate limited.");
      }
      if (stopped) {
        toast.error(
          `Stopped at the inbox retry limit after ${sent} sent. Try the rest in a few minutes.`,
        );
      }
      onRetried?.();
    } finally {
      setBusy(false);
      setProgress(0);
      setOpen(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="gap-2 border-[#e11d2e]/60 text-[#e11d2e] hover:bg-[#e11d2e]/10"
        disabled={total === 0 || busy}
        onClick={() => setOpen(true)}
        title={
          total === 0
            ? "No failed emails in the current filters and scope"
            : `Resend ${total} failed ${total === 1 ? "email" : "emails"} in view`
        }
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
        {busy ? `Resending ${progress}/${total}…` : `Resend failed${total > 0 ? ` (${total})` : ""}`}
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resend {total} failed {total === 1 ? "email" : "emails"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This retries every failed notification in the current filters ({scopeLabel}). Sends run
              one at a time; retries are limited to one per session every 90 seconds and 10 across the
              inbox every 10 minutes, so the run stops early if that limit is reached.
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
              {busy ? `Resending ${progress}/${total}…` : "Resend all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
