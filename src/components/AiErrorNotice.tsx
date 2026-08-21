import { Clock, TriangleAlert } from "lucide-react";
import { cleanErrorMessage, isQuotaError, QUOTA_BODY, QUOTA_HEADLINE } from "@/lib/ai-quota";

/**
 * Friendly failure state for AI calls. A rate-limit / quota failure gets a calm
 * cooldown card (nothing was charged, retry shortly); anything else keeps the
 * plain destructive alert so real bugs stay visible.
 */
export function AiErrorNotice({ error }: { error: string | null }) {
  if (!error) return null;

  if (isQuotaError(error)) {
    return (
      <div role="alert" className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-400">
          <Clock className="size-4" aria-hidden />
          {QUOTA_HEADLINE}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-foreground">{QUOTA_BODY}</p>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Your request was retried automatically with a growing delay before this notice appeared.
        </p>
      </div>
    );
  }

  return (
    <div role="alert" className="rounded-xl border border-destructive/50 bg-destructive/10 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
        <TriangleAlert className="size-4" aria-hidden />
        AI request failed
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
        {cleanErrorMessage(error)}
      </p>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Nothing was generated — no placeholder script is shown.
      </p>
    </div>
  );
}
