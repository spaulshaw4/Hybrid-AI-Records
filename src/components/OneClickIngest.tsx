import { memo } from "react";
import { CheckCircle2 } from "lucide-react";
import { AudioTimingDropZone } from "@/components/AudioTimingDropZone";
import type { AudioTimingMap } from "@/lib/audio-timing";

export type IngestMode = "analyze" | "write";

type Props = {
  timing: AudioTimingMap | null;
  fileName: string | null;
  onTiming: (map: AudioTimingMap | null, name: string | null, file?: File | null) => void;
  disabled?: boolean;
};

/**
 * Stage 1 — audio ingest only. Dropping a track validates its format and stores
 * the file in the global audio store. Nothing is dispatched to any API here:
 * generation only starts from the master execution button at the bottom.
 */
function OneClickIngestImpl({ timing, fileName, onTiming, disabled }: Props) {
  return (
    <div className="space-y-3">
      <AudioTimingDropZone
        timing={timing}
        fileName={fileName}
        onTiming={onTiming}
        disabled={disabled}
      />
      {timing && fileName ? (
        <p className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          <CheckCircle2 className="size-4" aria-hidden /> Track loaded — {fileName}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The song stays on your device until you hit Generate Master Video.
        </p>
      )}
    </div>
  );
}

export const OneClickIngest = memo(OneClickIngestImpl);
