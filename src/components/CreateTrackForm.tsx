import { useState } from "react";
import { CloudCheck } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useTrackGenerator } from "@/hooks/useTrackGenerator";

const busy: Array<ReturnType<typeof useTrackGenerator>["status"]> = ["queued", "running"];

function RetryMark({ "aria-hidden": hidden = true }: { "aria-hidden"?: boolean | "true" }) {
  return <CloudCheck className="size-4" aria-hidden={hidden === false ? undefined : true} />;
}

export function CreateTrackForm() {
  const { generateTrack, status, sessionId, error, audioUrl } = useTrackGenerator();
  const [prompt, setPrompt] = useState("");
  const [genreHint, setGenreHint] = useState("");

  const disabled = busy.includes(status);
  const handleRetry = () => {
    void generateTrack(prompt, genreHint);
  };

  return (
    <form
      className="mx-auto w-full max-w-3xl space-y-4 rounded-xl border border-white/[0.08] bg-zinc-900/40 p-4 text-zinc-100 shadow-2xl backdrop-blur-xl sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        void generateTrack(prompt, genreHint);
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="headless-prompt" className="text-xs text-muted-foreground">
          Prompt
        </Label>
        <Textarea
          id="headless-prompt"
          value={prompt}
          maxLength={2000}
          rows={4}
          disabled={disabled}
          placeholder="Describe the track you want to generate."
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="headless-genre" className="text-xs text-muted-foreground">
          Genre hint
        </Label>
        <Input
          id="headless-genre"
          value={genreHint}
          maxLength={120}
          disabled={disabled}
          placeholder="alt_rock"
          onChange={(event) => setGenreHint(event.target.value)}
        />
      </div>
      <Button type="submit" className="min-h-12 w-full" disabled={disabled || !prompt.trim()}>
        {disabled ? (status === "running" ? "Generating…" : "Queued…") : "Generate"}
      </Button>
      {sessionId ? (
        <p className="text-center text-xs text-muted-foreground" role="status">
          {status} · {sessionId}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {status === "failed" ? (
        <button
          type="button"
          aria-label="Retry generation"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
          onClick={handleRetry}
        >
          <RetryMark aria-hidden="true" />
          Retry generation
        </button>
      ) : null}
      {audioUrl ? (
        <audio className="w-full" controls src={audioUrl} preload="metadata">
          <track kind="captions" />
        </audio>
      ) : null}
    </form>
  );
}
