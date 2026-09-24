import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  extractChordProgression,
  extractSongPlanKey,
  fetchWorkerJob,
  formatCatalogKey,
  formatChordArrow,
  isWorkerSessionId,
  parseRelationalSnap,
  rememberWorkerSession,
  resolveCatalogKey,
  type RelationalSnap,
} from "@/lib/vault-catalog";

type Props = {
  busy: boolean;
  stage: string;
  progress: number;
  statusText?: string | null;
  genre?: string;
  title?: string;
  sessionId?: string | null;
  explicitKey?: string | null;
};

function stageLabel(stage: string): string {
  const value = (stage || "idle").trim();
  if (value === "music" || value === "sonic") return "COMPOSITION";
  if (value === "stems") return "DEMUX";
  return value.replace(/[_-]+/g, " ").toUpperCase();
}

export function ConductorTelemetryCard({
  busy,
  stage,
  progress,
  statusText,
  genre = "",
  title = "",
  sessionId = null,
  explicitKey = null,
}: Props) {
  const [liveKey, setLiveKey] = useState("");
  const [chords, setChords] = useState<string[]>([]);
  const [relational, setRelational] = useState<RelationalSnap | null>(null);
  const [liveStage, setLiveStage] = useState<string>("");

  const displayKey = useMemo(
    () => formatCatalogKey(liveKey) || resolveCatalogKey(genre, title, explicitKey),
    [liveKey, genre, title, explicitKey],
  );

  const displayChords = chords.length ? chords : extractChordProgression(null, displayKey);

  useEffect(() => {
    if (!isWorkerSessionId(sessionId || "")) {
      setLiveKey("");
      setChords([]);
      setRelational(null);
      setLiveStage("");
      return;
    }
    rememberWorkerSession(sessionId!);
    let cancelled = false;
    const tick = async () => {
      const job = await fetchWorkerJob(sessionId!);
      if (cancelled || !job) return;
      const key = extractSongPlanKey(job.song_plan);
      if (key) setLiveKey(key);
      const nextChords = extractChordProgression(job.song_plan, key || displayKey);
      if (nextChords.length) setChords(nextChords);
      setRelational(parseRelationalSnap(job) ?? parseRelationalSnap(job.note) ?? parseRelationalSnap(job.song_plan));
      if (job.status) setLiveStage(String(job.status));
    };
    void tick();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void tick();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, displayKey]);

  const snap = relational;
  const waiting = busy && !snap;

  return (
    <Card className="border-white/[0.08] bg-zinc-900/40">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Conductor</CardTitle>
            <CardDescription>Live diagnostics while the 96-bar form renders.</CardDescription>
          </div>
          <Badge variant={busy ? "default" : "secondary"} className="uppercase tracking-wide">
            {busy ? stageLabel(stage) : liveStage || "IDLE"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{statusText || (busy ? "Streaming runtime telemetry…" : "Last snap readout")}</span>
            <span className="tabular-nums">{Math.round(progress)}%</span>
          </div>
          <Progress value={Math.max(0, Math.min(100, progress))} className="h-1.5" />
        </div>

        <Tabs defaultValue="stage" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="stage">Stage</TabsTrigger>
            <TabsTrigger value="chords">Chords</TabsTrigger>
            <TabsTrigger value="relational">Relational</TabsTrigger>
          </TabsList>
          <TabsContent value="stage" className="space-y-2 pt-3 text-sm">
            <p>
              Progress stage:{" "}
              <span className="font-semibold text-foreground">{stageLabel(stage)}</span>
            </p>
            <p className="text-muted-foreground">
              Key lock <span className="font-mono text-foreground">{displayKey}</span>
              {genre ? ` · ${genre}` : ""}
            </p>
          </TabsContent>
          <TabsContent value="chords" className="pt-3">
            <p className="font-mono text-sm leading-relaxed text-foreground">
              {formatChordArrow(displayChords)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Active harmonic spine streamed from the song plan.
            </p>
          </TabsContent>
          <TabsContent value="relational" className="space-y-2 pt-3 text-sm">
            {waiting ? (
              <p className="text-muted-foreground">Waiting for [RELATIONAL] snap…</p>
            ) : snap ? (
              <dl className="grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">kick_bass_aligned</dt>
                  <dd className="font-semibold">
                    {snap.kickBassAligned == null ? "—" : snap.kickBassAligned ? "true" : "false"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">snaps</dt>
                  <dd className="font-semibold">{snap.snaps ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">median_shift_ms</dt>
                  <dd className="font-semibold">
                    {snap.medianShiftMs == null ? "—" : `${snap.medianShiftMs} ms`}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-muted-foreground">
                No snap readout yet. kick_bass_aligned, snap count, and median shift appear after mix.
              </p>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
