import { useEffect, useRef, useState } from "react";
import { History, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  clearPromptHistory,
  deletePromptVersion,
  readPromptHistory,
  recordPromptVersion,
  type PromptVersion,
} from "@/lib/prompt-history";

type Props = {
  /** Live Style & Sound Prompt text. */
  current: string;
  /** Restores an earlier version into the prompt box. */
  onRestore: (text: string) => void;
};

const stamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** One-click rollback to any earlier Style & Sound Prompt version. */
export function PromptHistoryList({ current, onRestore }: Props) {
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [open, setOpen] = useState(false);
  const skip = useRef(true);

  useEffect(() => {
    setVersions(readPromptHistory());
  }, []);

  // Debounced capture so typing bursts become one version.
  useEffect(() => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    const t = window.setTimeout(() => setVersions(recordPromptVersion(current)), 1200);
    return () => window.clearTimeout(t);
  }, [current]);

  if (versions.length === 0) return null;

  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <History className="size-4 text-primary" aria-hidden />
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Prompt history · {versions.length}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Show"}
        </Button>
      </div>

      {open && (
        <>
          <ul className="space-y-2">
            {versions.map((v, i) => (
              <li
                key={v.id}
                className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 p-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {stamp(v.at)}
                    {i === 0 ? " · latest" : ""}
                  </p>
                  <p className="truncate text-xs text-foreground">{v.text}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="gap-1.5"
                  onClick={() => {
                    onRestore(v.text);
                    toast.success("Prompt version restored.");
                  }}
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Restore
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete prompt version from ${stamp(v.at)}`}
                  onClick={() => setVersions(deletePromptVersion(v.id))}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="gap-1.5 text-muted-foreground"
            onClick={() => {
              setVersions(clearPromptHistory());
              toast.success("Prompt history cleared.");
            }}
          >
            <X className="size-3.5" aria-hidden />
            Clear history
          </Button>
        </>
      )}
    </div>
  );
}

export default PromptHistoryList;
