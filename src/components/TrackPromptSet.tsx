import { memo } from "react";
/**
 * Style-locked prompt set panel.
 *
 * Shows the numbered shot prompts generated from the uploaded track's audio
 * profile and lyrics, with copy / JSON export so the set can be reused in any
 * render pipeline.
 */

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, Copy, Download, Sparkles } from "lucide-react";
import type { PromptSet } from "@/lib/prompt-set.server";
import { estimateProjectCost, estimateShotCost, formatShotCost } from "@/lib/shot-cost";

function timecode(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.max(0, Math.round(seconds % 60));
  return `${m}:${String(s).padStart(2, "0")}`;
}

function TrackPromptSetBase({
  set,
  loading,
  disabled,
  trackName,
  onGenerate,
}: {
  set: PromptSet | null;
  loading: boolean;
  disabled?: boolean;
  trackName?: string | null;
  onGenerate: () => void;
}) {
  // Cost preview: every camera block is priced before generation starts.
  const projectCost = estimateProjectCost(
    (set?.prompts ?? []).map((p) => ({ seconds: p.seconds, vocalSync: p.vocalSync })),
  );

  const copyAll = async () => {
    if (!set) return;
    const text = set.prompts
      .map(
        (p) =>
          `#${String(p.index).padStart(2, "0")} [${timecode(p.startSeconds)} · ${p.seconds}s · ${p.section}]\n${p.prompt}` +
          (p.negative ? `\nNegative: ${p.negative}` : ""),
      )
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Prompt set copied.");
    } catch {
      toast.error("Copying isn't available in this browser.");
    }
  };

  const download = () => {
    if (!set) return;
    const blob = new Blob([JSON.stringify(set, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(trackName ?? "track").replace(/\.[a-z0-9]+$/i, "")}-prompt-set.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onGenerate} disabled={loading || disabled}>
          {loading ? (
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="mr-2 size-4" aria-hidden />
          )}
          {set ? "Regenerate prompt set" : "Generate prompt set"}
        </Button>
        {set && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={copyAll}>
              <Copy className="mr-2 size-4" aria-hidden />
              Copy all
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={download}>
              <Download className="mr-2 size-4" aria-hidden />
              JSON
            </Button>
          </>
        )}
      </div>

      {loading && !set && (
        <p className="text-sm text-muted-foreground">
          Reading the detected tempo, structure and lyrics, then locking one visual world across
          every shot…
        </p>
      )}

      {set && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Style lock: {set.styleLock}</Badge>
            {set.styleTags.map((tag) => (
              <Badge key={tag} variant="outline" className="font-normal">
                {tag}
              </Badge>
            ))}
          </div>

          {/* Running project total — shown before a single block is dispatched. */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              Estimated project cost
            </p>
            <p className="text-sm font-semibold tabular-nums">
              {projectCost.tokens} V Token{projectCost.tokens === 1 ? "" : "s"} · $
              {projectCost.usd.toFixed(2)}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {projectCost.shots} shot{projectCost.shots === 1 ? "" : "s"} ·{" "}
                {Math.round(projectCost.billableSeconds)}s billable
                {projectCost.lipSyncShots > 0
                  ? ` · ${projectCost.lipSyncShots} lip-sync pass${projectCost.lipSyncShots === 1 ? "" : "es"}`
                  : ""}
              </span>
            </p>
          </div>

          <ol className="space-y-3">
            {set.prompts.map((p) => {
              const cost = estimateShotCost(p.seconds, p.vocalSync);
              return (
                <li key={p.index} className="rounded-lg border border-border bg-card/60 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">
                      #{String(p.index).padStart(2, "0")}
                    </span>
                    <span>{timecode(p.startSeconds)}</span>
                    <span>· {p.seconds}s</span>
                    <span>· {p.section}</span>
                    {p.vocalSync && <Badge variant="secondary">lip-sync</Badge>}
                    <Badge
                      variant="outline"
                      className="ml-auto border-primary/40 font-mono text-[11px] text-primary"
                      title={`${Math.round(cost.billableSeconds)}s billable compute for this camera block`}
                    >
                      {formatShotCost(cost)}
                    </Badge>
                  </div>
                  {p.camera && (
                    <p className="mt-1 text-xs font-medium text-muted-foreground">{p.camera}</p>
                  )}
                  <p className="mt-1 text-sm leading-relaxed">{p.prompt}</p>
                </li>
              );
            })}
          </ol>


          {set.negativePrompt && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Locked exclusions:</span>{" "}
              {set.negativePrompt}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Memoised: the studio route re-renders often; this view only repaints when its own props change. */
export const TrackPromptSet = memo(TrackPromptSetBase);
