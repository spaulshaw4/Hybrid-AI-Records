/**
 * Side-by-side diff between a saved voice clip's stored record and the
 * `.meta.json` analysis sidecar uploaded next to the audio. Differing values
 * are highlighted so drift is obvious at a glance.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  buildClipMetadataDiff,
  countDifferences,
  loadClipSidecar,
  type MetadataDiffRow,
  type SidecarLoad,
} from "@/lib/clip-metadata-diff";
import type { VoiceProfile } from "@/lib/voice-library.functions";

const MISSING_COPY: Record<Exclude<SidecarLoad["status"], "ok">, string> = {
  missing: "No .meta.json sidecar was found next to this clip in storage.",
  unreadable: "The stored .meta.json sidecar could not be parsed.",
  "no-path": "This clip's storage path could not be resolved from its link.",
};

function cellClass(status: MetadataDiffRow["status"], side: "record" | "sidecar") {
  if (status === "changed") return "bg-destructive/15 text-foreground";
  if (status === "only-record" && side === "sidecar") return "text-muted-foreground/60";
  if (status === "only-sidecar" && side === "record") return "text-muted-foreground/60";
  return "";
}

export function ClipMetadataDiff({ voice }: { voice: VoiceProfile }) {
  const [loading, setLoading] = useState(true);
  const [load, setLoad] = useState<SidecarLoad | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadClipSidecar(voice.sample_url).then((result) => {
      if (cancelled) return;
      setLoad(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [voice.sample_url, reloadKey]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading stored analysis…
      </p>
    );
  }

  const sidecar = load?.status === "ok" ? load.data : null;
  const rows = buildClipMetadataDiff(voice, sidecar);
  const changed = countDifferences(rows);

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-background/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold">Metadata diff</p>
          {sidecar ? (
            changed > 0 ? (
              <Badge variant="destructive" className="text-[10px]">
                {changed} difference{changed === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                <Check className="mr-1 size-3" aria-hidden /> In sync
              </Badge>
            )
          ) : (
            <Badge variant="outline" className="text-[10px]">
              <AlertTriangle className="mr-1 size-3" aria-hidden /> Sidecar unavailable
            </Badge>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setReloadKey((k) => k + 1)}
          aria-label={`Reload stored analysis for ${voice.label}`}
        >
          <RefreshCw className="mr-1.5 size-3.5" aria-hidden /> Reload
        </Button>
      </div>

      {load && load.status !== "ok" ? (
        <p className="text-xs text-muted-foreground">{MISSING_COPY[load.status]}</p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] border-collapse text-xs">
          <caption className="sr-only">
            Saved record compared with the stored .meta.json analysis for {voice.label}
          </caption>
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <th scope="col" className="py-1 pr-3 font-medium">
                Field
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Saved record
              </th>
              <th scope="col" className="py-1 font-medium">
                Stored .meta.json
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border/40 align-baseline">
                <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground">
                  {row.label}
                  {row.status === "changed" ? <span className="sr-only"> (changed)</span> : null}
                </th>
                <td className={`py-1 pr-3 font-mono ${cellClass(row.status, "record")}`}>
                  {row.record}
                </td>
                <td className={`py-1 font-mono ${cellClass(row.status, "sidecar")}`}>
                  {row.sidecar}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Highlighted rows differ between what was saved with the clone and what the uploaded clip's
        analysis sidecar recorded. Dashes mean the value is only kept on one side.
      </p>
    </div>
  );
}

export default ClipMetadataDiff;
