import { memo } from "react";
import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";

export type AutoStage = {
  label: string;
  percent: number;
  failed?: boolean;
};

/**
 * The single production progress surface: one bar, one line of stage text.
 * Everything the pipeline is doing behind it goes to the console, not the UI.
 */
function AutoPipelineBarImpl({ stage }: { stage: AutoStage }) {
  return (
    <div
      className="space-y-3 rounded-lg border border-border bg-muted/30 p-5"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {!stage.failed && <Loader2 className="size-4 animate-spin text-primary" aria-hidden />}
        <span className={stage.failed ? "text-destructive" : undefined}>{stage.label}</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {Math.round(stage.percent)}%
        </span>
      </div>
      <Progress value={Math.max(0, Math.min(100, stage.percent))} />
    </div>
  );
}

export const AutoPipelineBar = memo(AutoPipelineBarImpl);
