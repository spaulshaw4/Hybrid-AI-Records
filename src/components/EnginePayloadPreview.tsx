import { useState } from "react";
import { ChevronDown, Code2, Copy, Terminal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { buildEngineCurl, buildEnginePayloadPreview, type AudioFormat } from "@/lib/engine-payload";
import { ReplicateKeyCheck } from "@/components/ReplicateKeyCheck";


type Props = { stylePrompt: string; lyrics: string; instrumental?: boolean; audioFormat?: AudioFormat };

/** Developer-visible preview of the exact JSON sent to minimax/music-2.6. */
export function EnginePayloadPreview({
  stylePrompt,
  lyrics,
  instrumental = false,
  audioFormat = "mp3",
}: Props) {
  const [open, setOpen] = useState(false);
  const payload = buildEnginePayloadPreview(stylePrompt, lyrics, instrumental, audioFormat);
  const json = JSON.stringify(payload, null, 2);
  const curl = buildEngineCurl(stylePrompt, lyrics, instrumental, audioFormat);

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied.`);
    } catch {
      toast.error(`Could not copy the ${label.toLowerCase()}.`);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-border/60 bg-background/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-2 px-1 text-xs">
            <Code2 className="size-4" aria-hidden />
            Payload preview
            <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
          </Button>
        </CollapsibleTrigger>
        {open ? (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-xs"
              onClick={() => void copyText(json, "Payload")}
            >
              <Copy className="size-3.5" aria-hidden />
              Copy JSON
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-xs"
              onClick={() => void copyText(curl, "cURL")}
            >
              <Terminal className="size-3.5" aria-hidden />
              Copy cURL
            </Button>
          </div>
        ) : null}
      </div>
      <CollapsibleContent className="space-y-2 px-3 pb-3">
        <pre className="max-h-72 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
          {json}
        </pre>
        <details className="rounded-lg border border-border/50 bg-muted/20 p-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            cURL (headers + payload)
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
            {curl}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Fill in <span className="font-mono">$REPLICATE_API_KEY</span> locally — keys are never
            sent to the browser.
          </p>
        </details>
        <ReplicateKeyCheck />

        <p className="text-xs text-muted-foreground">
          Exact request body sent when you generate.
          {payload.input.lyrics
            ? null
            : " Lyrics are empty — the Co-Producer will draft them before sending."}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
