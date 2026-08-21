import { memo, useRef, useState } from "react";
import { Loader2, PenLine, Sparkles, Waves } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { generateCinematicScript } from "@/lib/cinematic-script.functions";

import type { AudioTimingMap } from "@/lib/audio-timing";

type Props = {
  script: string;
  onScript: (next: string) => void;
  timing: AudioTimingMap | null;
  audioName: string | null;
  onTiming: (map: AudioTimingMap | null, name: string | null, file?: File | null) => void;
  styleMode: string;
  subjectMode: string;
  maxScript: number;
  disabled?: boolean;
};

/**
 * Script & song breakdown workspace.
 *
 * The song is analysed in the browser, then Gemini turns its tempo, structure
 * and cut points into a timecoded shot script — so the script is generated and
 * synced rather than pasted by hand.
 */
function ScriptComposerBase({
  script,
  onScript,
  timing,
  audioName,
  onTiming,
  styleMode,
  subjectMode,
  maxScript,
  disabled,
}: Props) {
  const generate = useServerFn(generateCinematicScript);
  const [busy, setBusy] = useState<"write" | "analyze" | null>(null);
  const autoRef = useRef<string | null>(null);

  const run = async (
    mode: "write" | "analyze",
    override?: { timing: AudioTimingMap | null },
  ) => {
    const map = override ? override.timing : timing;
    if (!map && script.trim().length < 10) {
      toast.error("Drop your song or type a one-line idea first.");
      return;
    }
    setBusy(mode);
    try {
      const result = await generate({
        data: {
          mode,
          styleMode,
          subjectMode,
          seed: script.slice(0, 4000),
          lyrics: script.length > 4000 ? script.slice(0, 8000) : "",
          timing: map
            ? {
                durationSeconds: map.durationSeconds,
                bpm: map.bpm,
                cuts: map.cuts,
                sections: map.sections ?? [],
              }
            : null,
        },
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (mode === "write") {
        onScript(result.script.slice(0, maxScript));
        toast.success("Script written and synced to the song's cuts.");
      } else {
        onScript(`${result.script}\n\n${script}`.trim().slice(0, maxScript));
        toast.success("Song breakdown added above your notes.");
      }
    } catch {
      toast.error("Sign in to use the AI script writer.");
    } finally {
      setBusy(null);
    }
  };

  const energy = timing?.sections?.length
    ? timing.sections.reduce((sum, s) => sum + (s.energy || 0), 0) / timing.sections.length
    : null;

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        {audioName
          ? `Using the track you dropped at the start — ${audioName}.`
          : "Drop your track at the top of the studio; it carries through every stage."}
      </p>

      {timing && (
        <div className="flex flex-wrap gap-2 text-[11px] font-medium">
          <span className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-primary">
            {timing.bpm ? `${Math.round(timing.bpm)} BPM` : "Free tempo"}
          </span>
          <span className="rounded-full border border-border bg-muted/30 px-3 py-1 text-muted-foreground">
            {timing.cuts.length} musical cuts
          </span>
          {energy !== null && (
            <span className="rounded-full border border-border bg-muted/30 px-3 py-1 text-muted-foreground">
              Scene energy {Math.round(energy * 100)}%
            </span>
          )}
        </div>
      )}

      {busy === "write" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
          Analyzing mood, tempo and scene energy — writing your synced script…
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={disabled || busy !== null}
          onClick={() => void run("write")}
        >
          {busy === "write" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-4" aria-hidden />
          )}
          {timing ? "Rewrite script from this song" : "Write script from my idea"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || busy !== null}
          onClick={() => void run("analyze")}
        >
          {busy === "analyze" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Waves className="size-4" aria-hidden />
          )}
          Analyze &amp; break down
        </Button>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="cinematic-script"
          className="flex items-center gap-2 text-sm font-medium"
        >
          <PenLine className="size-4 text-primary" aria-hidden /> Script
        </label>
        <Textarea
          id="cinematic-script"
          value={script}
          maxLength={maxScript}
          rows={12}
          className="border-border bg-input"
          placeholder="A one-line idea is enough — the AI writes the rest. Or paste your lyrics/treatment."
          onChange={(e) => onScript(e.target.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {script.length.toLocaleString()} / {maxScript.toLocaleString()} characters
          </span>
          <span className="font-medium text-primary">
            {timing
              ? `Locked to ${timing.cuts.length} musical cuts`
              : `Estimated runtime: ${(script.length / 30).toFixed(0)}s – 3.5m`}
          </span>
        </div>
      </div>
    </div>
  );
}



/** Memoised: the studio route re-renders often; this view only repaints when its own props change. */
export const ScriptComposer = memo(ScriptComposerBase);
export default ScriptComposer;
