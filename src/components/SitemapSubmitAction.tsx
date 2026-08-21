/**
 * Admin action: prompts for confirmation, submits the live sitemap URL to
 * Google Search Console, then shows the processing status Google reports back.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Loader2, TriangleAlert, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import {
  submitSitemapToSearchConsole,
  TARGET_SITE,
  type SitemapSubmissionResult,
} from "@/lib/search-console.functions";

const SITEMAP_URL = `${TARGET_SITE}sitemap.xml`;

export function SitemapSubmitAction({
  siteUrl,
  onSubmitted,
}: {
  /** Resolved Search Console property, passed straight back to the server. */
  siteUrl?: string;
  onSubmitted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SitemapSubmissionResult | null>(null);
  const submit = useServerFn(submitSitemapToSearchConsole);

  const mutation = useMutation({
    mutationFn: () => submit({ data: { sitemapUrl: SITEMAP_URL, siteUrl } }),
    onSuccess: (data) => {
      setResult(data);
      if (data.status === "ok") {
        toast.success("Sitemap submitted to Search Console");
        onSubmitted?.();
      } else {
        toast.message("Pick a Search Console property first");
      }
    },
    onError: (error: unknown) => {
      setResult(null);
      toast.error(error instanceof Error ? error.message : "Sitemap submission failed");
    },
  });

  const ok = result?.status === "ok" ? result : null;

  return (
    <div className="mt-6 border border-border-strong/60 bg-background/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Sitemap submission
          </p>
          <p className="mt-1 break-all text-sm text-foreground">{SITEMAP_URL}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <UploadCloud size={14} aria-hidden="true" />
          )}
          Submit sitemap to Search Console
        </Button>
      </div>

      {mutation.isError ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-[#e11d2e]">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {mutation.error instanceof Error ? mutation.error.message : "Submission failed."}
        </p>
      ) : null}

      {result?.status === "selection_required" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Several verified properties cover this domain — choose one at the top of the dashboard,
          then submit again: {result.candidates.join(", ")}
        </p>
      ) : null}

      {ok ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="flex items-center gap-2 text-foreground">
            <CheckCircle2 size={14} className="text-emerald-400" aria-hidden="true" />
            Submitted to <span className="font-mono text-xs">{ok.siteUrl}</span> at{" "}
            {new Date(ok.submittedAt).toLocaleString()}
          </p>
          {ok.sitemap ? (
            <dl className="grid gap-2 sm:grid-cols-4">
              <Stat label="Status" value={ok.sitemap.isPending ? "Pending" : "Processed"} />
              <Stat label="Submitted URLs" value={String(ok.sitemap.submitted)} />
              <Stat label="Errors" value={String(ok.sitemap.errors)} />
              <Stat
                label="Last downloaded"
                value={
                  ok.sitemap.lastDownloaded
                    ? new Date(ok.sitemap.lastDownloaded).toLocaleString()
                    : "—"
                }
              />
            </dl>
          ) : (
            <p className="text-muted-foreground">
              Google accepted the submission but hasn't reported a status yet — it usually appears
              within a few minutes.
            </p>
          )}
        </div>
      ) : null}

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit sitemap to Search Console?</AlertDialogTitle>
            <AlertDialogDescription>
              This tells Google to re-fetch {SITEMAP_URL} for the connected property. It's safe to
              repeat, but Google only re-crawls on its own schedule.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => mutation.mutate()}>Submit sitemap</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
