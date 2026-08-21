import { useCallback, useRef, useState } from "react";
import { AudioLines, Loader2, Music4, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AUDIO_ACCEPT_ATTR,
  MAX_AUDIO_BYTES,
  formatBytes,
  validateAudioUpload,
} from "@/lib/audio-upload-validation";
import {
  describeStems,
  describeStructure,
  describeTiming,
  formatSectionTime,
  type AudioTimingMap,
} from "@/lib/audio-timing";

type Props = {
  timing: AudioTimingMap | null;
  fileName: string | null;
  onTiming: (timing: AudioTimingMap | null, fileName: string | null, file?: File | null) => void;
  disabled?: boolean;
};

/**
 * Story mode song drop zone. The uploaded track is analysed locally and its
 * tempo, transients and energy drive the render's cut timing — the audio file
 * itself never leaves the browser.
 */
export function AudioTimingDropZone({ timing, fileName, onTiming, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      // Local format/size gate — nothing is dispatched upstream until this passes.
      const check = validateAudioUpload(file);
      if (!check.ok) {
        setRejection(check.error);
        toast.error(check.error);
        return;
      }
      setRejection(null);
      setBusy(true);
      try {
        const { analyzeAudioTiming } = await import("@/lib/audio-timing");
        const map = await analyzeAudioTiming(file);
        onTiming(map, file.name, file);
        toast.success(`Song locked in — ${map.cuts.length} musical cuts mapped.`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't analyse that track.");
      } finally {
        setBusy(false);
      }
    },
    [onTiming],
  );

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void handleFile(e.dataTransfer.files?.[0]);
        }}
        className={`rounded-xl border border-dashed p-6 text-center transition-colors ${
          over ? "border-primary bg-primary/10" : "border-border bg-muted/30"
        }`}
      >
        {busy ? (
          <Loader2 className="mx-auto size-7 animate-spin text-primary" aria-hidden />
        ) : (
          <AudioLines className="mx-auto size-7 text-primary" aria-hidden />
        )}
        <p className="mt-2 text-sm font-medium">
          {busy ? "Mapping the song's timing…" : "Drop your song here"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          The track's tempo, transients and energy set every scene cut and the render length.
          Analysis runs on your device — the file is never uploaded.
          <br />
          MP3, WAV, M4A or FLAC · max {formatBytes(MAX_AUDIO_BYTES)}.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          <Music4 className="size-4" aria-hidden /> Choose audio track
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={AUDIO_ACCEPT_ATTR}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void handleFile(file);
          }}
        />
      </div>

      {rejection && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive"
        >
          {rejection}
        </p>
      )}

      {timing && (
        <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-primary">{fileName}</p>
              <p className="text-xs text-muted-foreground">{describeTiming(timing)}</p>
              {describeStems(timing) && (
                <p className="text-[11px] text-muted-foreground/80">{describeStems(timing)}</p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onTiming(null, null, null)}
            >
              <X className="size-4" aria-hidden /> Remove
            </Button>
          </div>

          {timing.sections?.length > 0 && (
            <div className="space-y-2 border-t border-primary/30 pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Detected structure — drives the narrative progression
              </p>
              <div
                className="flex h-6 w-full overflow-hidden rounded-sm"
                role="img"
                aria-label={`Song structure: ${describeStructure(timing)}`}
              >
                {timing.sections.map((section) => (
                  <span
                    key={`${section.start}-${section.label}`}
                    className="bg-primary"
                    style={{
                      flexGrow: Math.max(0.5, section.end - section.start),
                      opacity: 0.25 + section.energy * 0.75,
                    }}
                    aria-hidden
                  />
                ))}
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {timing.sections.map((section) => (
                  <li
                    key={`${section.start}-${section.label}-label`}
                    className="rounded-full border border-primary/40 bg-background/40 px-2 py-0.5 text-[10px] font-medium capitalize text-foreground"
                  >
                    {section.label} · {formatSectionTime(section.start)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

export default AudioTimingDropZone;
