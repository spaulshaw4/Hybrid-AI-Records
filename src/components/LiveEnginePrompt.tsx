import { useMemo } from "react";
import { Copy, Radio } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  ENGINE_MODEL,
  buildEnginePayloadPreview,
  type AudioFormat,
} from "@/lib/engine-payload";

type Props = {
  stylePrompt: string;
  lyrics: string;
  instrumental?: boolean;
  audioFormat?: AudioFormat;
};

/**
 * Always-visible, real-time mirror of the resolved Replicate `prompt` field.
 * Recomputes on every keystroke in the Style & Sound Prompt box.
 */
export function LiveEnginePrompt({
  stylePrompt,
  lyrics,
  instrumental = false,
  audioFormat = "mp3",
}: Props) {
  const payload = useMemo(
    () => buildEnginePayloadPreview(stylePrompt, lyrics, instrumental, audioFormat),
    [stylePrompt, lyrics, instrumental, audioFormat],
  );
  const resolved = payload.input.prompt;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(resolved);
      toast.success("Resolved prompt copied.");
    } catch {
      toast.error("Could not copy the prompt.");
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-primary/30 bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Radio className="size-3.5 text-primary" aria-hidden />
          Live engine prompt
        </span>
        <Button variant="outline" size="sm" className="gap-2 text-xs" onClick={() => void copy()}>
          <Copy className="size-3.5" aria-hidden />
          Copy
        </Button>
      </div>

      <pre
        aria-live="polite"
        aria-label="Resolved prompt sent to the music engine"
        className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground"
      >
        {resolved || "— nothing yet. Start typing your style above."}
      </pre>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span>{ENGINE_MODEL}</span>
        <span>is_instrumental: {String(payload.input.is_instrumental)}</span>
        <span>lyrics_optimizer: true</span>
        <span>audio_format: {payload.input.audio_format}</span>
        <span>prompt: {resolved.length} chars</span>
        <span>lyrics: {payload.input.lyrics.length} chars</span>
      </div>
    </div>
  );
}
