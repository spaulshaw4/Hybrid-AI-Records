import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRenderMachine } from "@/hooks/useRenderMachine";
import { useRenderLoopGuard } from "@/hooks/useRenderLoopGuard";
import { RenderDebugOverlay } from "@/components/RenderDebugOverlay";
import {
  logTelemetry,
  markFirstFrame,
  markRunStart,
  recordBlockEnd,
  recordBlockStart,
  recordBackoff,
  recordLatency,
  recordReconnect,
} from "@/lib/render-telemetry";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Download,
  Film,
  Globe,
  Image as ImageIcon,
  Lock,
  Palette,
  ShieldCheck,
  Sliders,
  Sparkles,
  Square,
  UserPlus,
  Wand2,
} from "lucide-react";



import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GENRE_LAWS } from "@/lib/cinematic-genre";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { HybridTokenIcon } from "@/components/HybridTokenIcon";
import { ScriptComposer } from "@/components/ScriptComposer";
import { getStemState, resetStems, startStemWorker } from "@/lib/stem-worker";
import { snapDurationsToDownbeats } from "@/lib/downbeats";
import { setMasterAudio } from "@/lib/audio-store";
import { SyncAccuracyReport } from "@/components/SyncAccuracyReport";
import { preflightAudio, type AudioPreflightReport } from "@/lib/audio-preflight";
import { AiErrorNotice } from "@/components/AiErrorNotice";
import { showAiError } from "@/lib/ai-quota";

import { VideoMoodboard } from "@/components/VideoMoodboard";
import {
  DEFAULT_STYLE,
  STYLE_GROUPS,
  readMoodBoard,
  writeMoodBoard,
  type MoodBoard as MoodBoardValue,
} from "@/lib/visual-styles";
import type { AudioTimingMap } from "@/lib/audio-timing";
import { PRODUCER_NAME } from "@/lib/producer-identity";

import { supabase } from "@/integrations/supabase/client";
import { getVTokenBalance } from "@/lib/v-tokens.functions";
import { useServerFn } from "@tanstack/react-start";
import {
  startCinematicRender,
  pollCinematicRender,
  renderCinematicScene,
  cancelCinematicRender,
} from "@/lib/cinematic-render.functions";
import { ShotAudioTimeline } from "@/components/ShotAudioTimeline";
import { BeatBlockBuilder } from "@/components/BeatBlockBuilder";
import { StudioStageNav } from "@/components/StudioStageNav";
import { OneClickIngest, type IngestMode } from "@/components/OneClickIngest";
import { AutoPipelineBar, type AutoStage } from "@/components/AutoPipelineBar";
import {
  CinematicRenderProgress,
  type CinematicProgress,
  type SceneProgress,
} from "@/components/CinematicRenderProgress";
import { lipsyncCinematicShot } from "@/lib/lipsync.functions";
import {
  CinematicMasterPlayer,
  type MasterClip,
} from "@/components/CinematicMasterPlayer";
import type { ConceptPreviewValue } from "@/components/ConceptPreview";
import { buildCinematicConcept } from "@/lib/concept-preview.functions";
import { CharacterBuilder } from "@/components/CharacterBuilder";
import { CharacterAnchorFrame } from "@/components/CharacterAnchorFrame";
import {
  EMPTY_CHARACTER,
  hasCharacterProfile,
  type CharacterProfile,
} from "@/lib/character-profile";
import { tuneStylePrompt } from "@/lib/cinematic-style.functions";
import { generateCinematicScript } from "@/lib/cinematic-script.functions";
import { generateTrackPromptSet } from "@/lib/prompt-set.functions";
import type { PromptSet } from "@/lib/prompt-set.server";
import { TrackPromptSet } from "@/components/TrackPromptSet";





import {
  V_DURATION_STEP,
  V_MAX_DURATION,
  V_MIN_DURATION,
  V_TOKEN_SECONDS as V_TOKEN_SECONDS_RULE,
  quoteVRender,
} from "@/lib/v-tokens";
import { V_BETA_NOTICE, V_RENDER_BETA } from "@/lib/v-beta";
import { LOCAL_MOCK_MODE, LOCAL_MOCK_NOTICE } from "@/lib/local-mock";

// Mock-mode state is diagnostic only — it is logged, never surfaced in the UI.
if (typeof window !== "undefined" && LOCAL_MOCK_MODE) console.log("[cinematic]", LOCAL_MOCK_NOTICE);

import { toast } from "sonner";
import { SITE_URL } from "@/lib/release-schema";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

const TITLE = "Visual Engine — Hybrid AI Records";
const DESCRIPTION =
  "Zero-editing automated video pipeline: drop a script or song breakdown and the Hybrid stack orchestrates the full cinematic master.";

export const Route = createFileRoute("/cinematic-studio")({
  errorComponent: RouteErrorFallback,
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${SITE_URL}/cinematic-studio` },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/cinematic-studio` }],
  }),
  component: CinematicStudioPage,
});

const MAX_SCRIPT = 15000;

/** One V Token covers 60 seconds (1 minute) of V Engine render time. */
const V_TOKEN_SECONDS = V_TOKEN_SECONDS_RULE;
const V_TOKEN_PRICE = 12.5;
const MIN_DURATION = V_MIN_DURATION;
const MAX_DURATION = V_MAX_DURATION; // 14 minutes = 4 V Tokens
const DURATION_STEP = V_DURATION_STEP;

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function CinematicStudioPage() {
  const [script, setScript] = useState("");
  const [subjectMode, setSubjectMode] = useState("people");
  const [styleMode, setStyleMode] = useState(DEFAULT_STYLE);
  // Manual override for the genre visual laws + mood used to storyboard shots.
  // "auto" keeps the detector in charge.
  const [genreOverride, setGenreOverride] = useState("auto");
  const [moodOverride, setMoodOverride] = useState("");
  const [moodBoard, setMoodBoard] = useState<MoodBoardValue>({ references: [], notes: "" });
  const [character, setCharacter] = useState<CharacterProfile>(EMPTY_CHARACTER);
  const characterPhoto = character.referenceImage;
  const [isTuningStyle, setIsTuningStyle] = useState(false);

  const [audioTiming, setAudioTiming] = useState<AudioTimingMap | null>(null);
  const [audioName, setAudioName] = useState<string | null>(null);
  /** Object URL for the uploaded song — muxed onto the stitched master. */
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // The master audio File is held for the whole render so the assembly step can
  // mux the original, untouched track onto the finished picture.
  const [audioFile, setAudioFile] = useState<File | null>(null);


  const [duration, setDuration] = useState(V_TOKEN_SECONDS);
  const render = useRenderMachine();
  // Safeguard: if the studio ever repaints in a tight loop, cap it and log a
  // diagnostic instead of letting the viewport thrash silently.
  useRenderLoopGuard("cinematic-studio", {
    limit: 50,
    context: () => ({ status: render.status, note: render.note }),
  });
  const isGenerating = render.busy;
  const canRetry = render.canRetry;
  const stage = render.note;
  /** Stable handle for background loops so they never re-subscribe. */
  const renderRef = useRef(render);
  renderRef.current = render;

  // Perf instrumentation surface: always available in preview/dev, and on any
  // session opened with ?debug=render (opens expanded).
  const [debugOpen, setDebugOpen] = useState(false);
  const [showRenderStats, setShowRenderStats] = useState(import.meta.env.DEV);
  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("debug");
    if (flag === "render" || flag === "1") {
      setShowRenderStats(true);
      setDebugOpen(true);
    }
  }, []);
  const [isPublished, setIsPublished] = useState(false);

  const [vBalance, setVBalance] = useState<number | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [logline, setLogline] = useState("");
  const [scenes, setScenes] = useState<
    { index: number; title: string; shot: string; seconds: number; vocalSync?: boolean }[]
  >([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [clips, setClips] = useState<MasterClip[]>([]);
  /** Latest master-track pre-flight verdict; a failing check blocks the render. */
  const [audioCheck, setAudioCheck] = useState<AudioPreflightReport | null>(null);
  /** Blocks that actually completed the lip-sync stage, for the sync report. */
  const [lipSyncedIndexes, setLipSyncedIndexes] = useState<number[]>([]);
  const [progress, setProgress] = useState<CinematicProgress | null>(null);
  
  const [concept, setConcept] = useState<ConceptPreviewValue | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  /** Exact upstream AI error, shown on screen instead of any demo fallback. */
  const [aiError, setAiError] = useState<string | null>(null);
  /** Style-locked prompt set generated from the uploaded track. */
  const [promptSet, setPromptSet] = useState<PromptSet | null>(null);
  const [buildingPrompts, setBuildingPrompts] = useState(false);




  // The concept board is bound to one exact set of inputs. Change the script,
  // style, genre law or mood and the previous board no longer describes this
  // track, so it is discarded rather than shown (or rendered) stale.
  const conceptKey = `${script}|${styleMode}|${subjectMode}|${genreOverride}|${moodOverride}`;
  const conceptKeyRef = useRef(conceptKey);
  useEffect(() => {
    if (conceptKeyRef.current === conceptKey) return;
    conceptKeyRef.current = conceptKey;
    setConcept(null);
  }, [conceptKey]);






  /** Live plan for the current render so failed blocks can resume in place. */
  const runCtxRef = useRef<{
    scenes: { index: number; title: string; shot: string; seconds: number; vocalSync?: boolean }[];
    refPhotos: string[];
    /** Genre Visual Law governing this render. */
    genreId: string | null;
    startedAt: number;
    estimatedTotal: number;
    states: SceneProgress["state"][];
    clips: MasterClip[];
  } | null>(null);


  const startRender = useServerFn(startCinematicRender);
  const tuneStyle = useServerFn(tuneStylePrompt);
  const writeScript = useServerFn(generateCinematicScript);
  const [testScript, setTestScript] = useState("");
  const [testingScript, setTestingScript] = useState(false);

  const pollRender = useServerFn(pollCinematicRender);
  const renderScene = useServerFn(renderCinematicScene);
  const lipsyncShot = useServerFn(lipsyncCinematicShot);
  const cancelRender = useServerFn(cancelCinematicRender);

  /** Set when the producer aborts: every loop checkpoint bails out on it. */
  const cancelRef = useRef(false);
  /** Prediction currently in flight, so Cancel can terminate it upstream. */
  const activeJobRef = useRef<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  /** One-click chain: idle → running (single bar) → done (player only). */
  const [autoPhase, setAutoPhase] = useState<"idle" | "running" | "done">("idle");
  const [autoStage, setAutoStage] = useState<AutoStage | null>(null);

  /** Decoded master track, cached for the whole run so slicing stays cheap. */
  const decodedMasterRef = useRef<{ buffer: AudioBuffer; close: () => void } | null>(null);
  const audioFileRef = useRef<File | null>(null);

  /**
   * Returns the master-track slice under a shot as a base64 wav data URL, the
   * audio context the omni-modal engine generates against. Null when no track
   * has been uploaded — the render then runs picture-only.
   */
  const sliceAudioForShot = useCallback(
    async (startSeconds: number, seconds: number): Promise<string | null> => {
      const file = audioFileRef.current;
      if (!file) return null;
      try {
        const { decodeMaster, sliceToWav, toBase64 } = await import("@/lib/audio-slice");
        if (!decodedMasterRef.current) decodedMasterRef.current = await decodeMaster(file);
        const wav = sliceToWav(decodedMasterRef.current.buffer, startSeconds, seconds);
        return `data:audio/wav;base64,${toBase64(wav)}`;
      } catch (err) {
        console.error("[cinematic] audio conditioning slice failed", err);
        return null;
      }
    },
    [],
  );

  /**
   * Selective lip-sync: shots tagged `vocalSync` get the audio slice under
   * their own timestamp run through the sync engine and the synced clip
   * replaces the silent one. Every other shot keeps its raw diffusion clip.
   */
  const syncShotToVocals = useCallback(
    async (clipUrl: string, startSeconds: number, seconds: number, shotIndex: number) => {
      const file = audioFileRef.current;
      if (!file) return clipUrl;
      try {
        const { decodeMaster, sliceToWav, toBase64 } = await import("@/lib/audio-slice");
        // Prefer the isolated vocal stem — Wav2Lip/SadTalker track the mouth far
        // more accurately without drums and instruments in the signal.
        const stems = getStemState();
        let source = stems.vocalBuffer;
        if (!source) {
          if (!decodedMasterRef.current) decodedMasterRef.current = await decodeMaster(file);
          source = decodedMasterRef.current.buffer;
        }
        const wav = sliceToWav(source, startSeconds, seconds);
        const result = await lipsyncShot({
          data: { videoUrl: clipUrl, audioWavBase64: toBase64(wav), shotIndex },
        });
        if (result.ok) return result.videoUrl;
        console.error(`[cinematic] lip-sync failed on block ${shotIndex + 1}`, result.error);
        toast.message(`Lip-sync skipped on block ${shotIndex + 1} — ${result.error}`);
      } catch (err) {
        console.error(`[cinematic] lip-sync error on block ${shotIndex + 1}`, err);
      }
      return clipUrl;
    },
    [lipsyncShot],
  );


  /** Mood board is producer-level: it persists between sessions. */
  useEffect(() => {
    const saved = readMoodBoard();
    if (saved.grade || (saved.references?.length ?? 0) > 0 || (saved.notes ?? "").trim()) {
      setMoodBoard(saved);
    }
  }, []);

  const updateMoodBoard = useCallback((next: MoodBoardValue) => {
    setMoodBoard(next);
    writeMoodBoard(next);
  }, []);

  /**
   * Stable upload handler for the memoised script composer. Declaring it inline
   * in JSX gave it a new identity on every parent render, which defeated the
   * child's memoisation and remounted the upload panel mid-render.
   */
  const handleTiming = useCallback(
    (map: AudioTimingMap | null, name: string | null, file?: File | null) => {
      setAudioTiming(map);
      setAudioName(name);
      setAudioFile(file ?? null);
      audioFileRef.current = file ?? null;
      // Single global handoff — every later station reads this track.
      setMasterAudio(file ?? null, name, map);
      // A new track means a new film: drop any concept built from the previous
      // upload so nothing stale is shown or rendered.
      setConcept(null);
      setPromptSet(null);
      autoPromptRef.current = null;
      setLogline("");
      setScenes([]);
      decodedMasterRef.current?.close();
      decodedMasterRef.current = null;

      // Background stem worker: isolates the vocal stem (lip-sync source) and
      // the rhythmic stem (downbeat source) while the producer keeps working.
      if (file) {
        void startStemWorker(file).then((stems) => {
          if (stems.status === "ready" && stems.grid) {
            toast.message(
              `Stems isolated — ${stems.grid.downbeats.length} downbeats detected at ~${stems.grid.bpm} BPM.`,
            );
          }
        });
      } else {
        resetStems();
      }

      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return file ? URL.createObjectURL(file) : null;
      });
      if (map) {
        setSubjectMode("story");
        setDuration(
          Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(map.durationSeconds))),
        );
      }
    },
    [],
  );

  /** Stable character handler: swapping the lead clears the stale concept board. */
  const handleCharacterChange = useCallback((next: CharacterProfile) => {
    setCharacter(next);
    setConcept(null);
  }, []);




  // The elapsed-time clock now lives inside the memoised progress panel, so a
  // running render no longer re-renders this whole route once a second.




  const vTokens = quoteVRender(duration).tokens;
  const totalCost = (vTokens * V_TOKEN_PRICE).toFixed(2);
  const shortBy = vBalance === null ? 0 : Math.max(0, vTokens - vBalance);

  const refreshVBalance = useCallback(async () => {
    try {
      const result = await getVTokenBalance({ data: undefined });
      setVBalance(result.balance);
    } catch {
      setVBalance(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setSignedIn(Boolean(data.session));
      if (data.session) await refreshVBalance();
    })();
    const onChanged = () => void refreshVBalance();
    window.addEventListener("hybrid:v-tokens-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("hybrid:v-tokens-changed", onChanged);
    };
  }, [refreshVBalance]);

  /**
   * Renders every scene block that isn't finished yet, resuming from whatever
   * the last attempt completed. Retrying never re-charges V Tokens and never
   * re-renders a block that already succeeded.
   */
  const runBlocks = useCallback(
    async (initial?: { jobId: string; engine: "primary" | "backup" | "reserve" }) => {
      const ctx = runCtxRef.current;
      if (!ctx) return;

      const { scenes: sceneShots, refPhotos, genreId, startedAt, estimatedTotal } = ctx;
      const totalScenes = sceneShots.length;
      const sceneStates = ctx.states;
      const collected = ctx.clips;

      const sceneList = sceneShots.map((scene) => ({
        index: scene.index,
        title: scene.title,
        seconds: scene.seconds,
      }));

      const STAGE_LABEL: Record<string, string> = {
        starting: "queued on the engine",
        processing: "rendering",
        succeeded: "finishing",
        failed: "failed",
      };

      const paintProgress = (
        sceneIndex: number,
        jobPercent: number,
        engine: "primary" | "backup" | "reserve",
        stage: "starting" | "processing" | "succeeded" | "failed" = "processing",
      ) => {
        const elapsed = (Date.now() - startedAt) / 1000;
        const done = sceneStates.filter((s) => s === "done").length;
        const pct = Math.max(
          4,
          Math.min(99, Math.round(((done + jobPercent / 100) / totalScenes) * 100)),
        );
        const stageLabel = STAGE_LABEL[stage] ?? "rendering";
        renderRef.current.progress(
          `${done} of ${totalScenes} blocks ready — block ${Math.min(
            sceneIndex + 1,
            totalScenes,
          )} ${stageLabel} (${Math.round(jobPercent)}% of block · ${pct}% overall)`,
        );
        setProgress({
          phase: "render",
          phaseState: "active",
          percent: pct,
          engine,
          note: `Block ${Math.min(sceneIndex + 1, totalScenes)} ${stageLabel} — ${Math.round(
            jobPercent,
          )}%`,
          scenes: sceneList.map((s, i) => ({
            ...s,
            state: sceneStates[i] ?? "pending",
            percent: i === sceneIndex ? jobPercent : undefined,
          })),
          startedAt,
          etaSeconds:
            pct > 4
              ? Math.max(5, Math.round(elapsed * (100 / pct) - elapsed))
              : Math.max(15, estimatedTotal - elapsed),
        });
      };


      let failure: string | null = null;
      let failedCount = 0;
      // A hard stop only happens when the render provider itself refuses to
      // bill (402) — everything else just marks that shot failed and the queue
      // keeps going so one bad shot can't kill a 33-block sequence.
      let hardStop = false;

      for (let i = 0; i < totalScenes; i++) {
        if (sceneStates[i] === "done") continue;
        if (hardStop || cancelRef.current) break;
        const scene = sceneShots[i]!;
        sceneStates[i] = "active";
        recordBlockStart(i + 1);
        let blockError: string | null = null;

        let jobId: string | null = null;
        let engine: "primary" | "backup" | "reserve" = "primary";
        if (i === 0 && initial) {
          jobId = initial.jobId;
          engine = initial.engine;
        } else {
          // Omni-modal conditioning: the slice of the master track that plays
          // under this shot travels with the prompt and the anchor images, so
          // the engine renders picture and synced audio in one pass.
          const shotStart = sceneShots.slice(0, i).reduce((sum, s) => sum + s.seconds, 0);
          const audioReference = await sliceAudioForShot(shotStart, scene.seconds);
          const dispatchStartedAt = Date.now();
          const dispatched = await renderScene({
            data: {
              shot: scene.shot,
              seconds: scene.seconds,
              ...(refPhotos[0] ? { referenceImage: refPhotos[0] } : {}),
              ...(genreId ? { genreId } : {}),
              ...(refPhotos.length ? { styleReferences: refPhotos } : {}),
              ...(audioReference ? { audioReference } : {}),
            },
          });
          recordLatency(Date.now() - dispatchStartedAt);
          if (!dispatched.ok) {
            const detail = "detail" in dispatched ? (dispatched.detail ?? "") : "";
            const status = "status" in dispatched ? dispatched.status : null;
            console.error(
              `[cinematic] block ${i + 1}/${totalScenes} dispatch failed`,
              { status, error: dispatched.error, detail },
            );
            recordReconnect("render-dispatch", `block ${i + 1}: ${dispatched.error}`);
            blockError = detail && !dispatched.error.includes(detail)
              ? `${dispatched.error} — ${detail}`
              : dispatched.error;
            if (status === 402) {
              hardStop = true;
              blockError = `Render provider billing stop (402) — this is an external render-credit limit, not your V Token wallet. ${detail || dispatched.error}`;
            }
          } else {
            jobId = dispatched.jobId;
            engine = dispatched.engine;
          }
        }

        if (jobId) {
          activeJobRef.current = jobId;
          paintProgress(i, 0, engine, "starting");

          const deadline = Date.now() + 8 * 60_000;
          // Relaxed, fixed 4s browser-side poll — no server-side wait loops.
          const delay = 4000;
          let clipUrl: string | null = null;
          while (Date.now() < deadline) {
            if (cancelRef.current) {
              blockError = "Canceled by the producer.";
              break;
            }
            await new Promise((resolve) => window.setTimeout(resolve, delay));
            if (cancelRef.current) {
              blockError = "Canceled by the producer.";
              break;
            }
            recordBackoff("render-poll", delay);
            
            const polledAt = Date.now();
            let next: Awaited<ReturnType<typeof pollRender>>;
            try {
              next = await pollRender({ data: { jobId } });
            } catch (err) {
              // A dropped poll is transient — keep the session alive and retry.
              recordReconnect(
                "render-poll",
                `block ${i + 1}: ${err instanceof Error ? err.message : "poll failed"}`,
              );
              continue;
            }
            recordLatency(Date.now() - polledAt);
            if (next.status === "completed" && (next.videoUrl || next.previewUrl)) {
              clipUrl = next.videoUrl ?? next.previewUrl ?? null;
              paintProgress(i, 100, engine, "succeeded");
              break;
            }
            if (next.status === "failed") {
              blockError = next.error ?? "The render failed.";
              recordReconnect("render-poll", `block ${i + 1}: ${blockError}`);
              console.error(`[cinematic] block ${i + 1} render failed`, next);
              break;
            }
            paintProgress(i, next.progress || 0, engine, next.stage ?? "processing");
          }


          activeJobRef.current = null;

          if (!blockError && !clipUrl) {
            blockError = "This scene block timed out.";
          }

          if (clipUrl && !blockError) {
            sceneStates[i] = "done";
            let finalUrl = clipUrl;
            if (scene.vocalSync && audioFileRef.current) {
              renderRef.current.progress(`Lip-syncing block ${i + 1} of ${totalScenes}…`);
              const startSeconds = sceneShots
                .slice(0, i)
                .reduce((sum, s) => sum + s.seconds, 0);
              finalUrl = await syncShotToVocals(clipUrl, startSeconds, scene.seconds, i);
              if (finalUrl !== clipUrl) {
                setLipSyncedIndexes((prev) =>
                  prev.includes(scene.index) ? prev : [...prev, scene.index],
                );
              }
            }
            collected.push({
              index: scene.index,
              title: scene.title,
              seconds: scene.seconds,
              url: finalUrl,
            });
            collected.sort((a, b) => a.index - b.index);
            setClips([...collected]);
            setVideoUrl(collected[0]?.url ?? null);
            markFirstFrame();
            recordBlockEnd(i + 1, "done");
            toast.success(`Block ${i + 1} of ${totalScenes} ready — ${scene.title}`, {
              id: `cinematic-block-${scene.index}`,
            });
            paintProgress(i + 1, 0, engine);
            continue;
          }
        }

        sceneStates[i] = "failed";
        recordBlockEnd(i + 1, "failed");
        failedCount += 1;
        failure = blockError ?? "This scene block failed.";
        toast.error(`Block ${i + 1} failed — ${failure}`, {
          id: `cinematic-block-${scene.index}`,
        });
        paintProgress(i + 1, 0, engine);
      }

      if (cancelRef.current) {
        sceneStates.forEach((state, i) => {
          if (state === "active") sceneStates[i] = "failed";
        });
        renderRef.current.fail("Render canceled.");
        setProgress((prev) =>
          prev
            ? {
                ...prev,
                phaseState: "failed",
                note: "Render canceled — finished blocks are kept and no extra V Tokens are charged.",
                scenes: sceneList.map((s, i) => ({ ...s, state: sceneStates[i] ?? "pending" })),
              }
            : prev,
        );
        toast.message("Render canceled — completed blocks are kept, retry resumes the rest.");
        return;
      }

      if (failure) {
        sceneStates.forEach((state, i) => {
          if (state === "active") sceneStates[i] = "failed";
        });
        const pending = sceneStates.filter((s) => s !== "done").length;
        renderRef.current.fail(failure);
        logTelemetry("render", `Run failed — ${failure}`);
        toast.error(
          `${failure} ${collected.length} of ${totalScenes} blocks are ready — retry to render the remaining ${pending} (${failedCount} failed). No extra V Tokens are charged.`,
        );
        setProgress((prev) =>
          prev
            ? {
                ...prev,
                phaseState: "failed",
                note: failure,
                scenes: sceneList.map((s, i) => ({ ...s, state: sceneStates[i] ?? "pending" })),
              }
            : prev,

        );
        return;
      }

      renderRef.current.complete();
      setProgress({
        phase: "archive",
        phaseState: "done",
        percent: 100,
        engine: initial?.engine ?? "primary",
        scenes: sceneList.map((s) => ({ ...s, state: "done" as const })),
        startedAt,
        etaSeconds: 0,
      });
      toast.success(
        `Cinematic master ready — ${totalScenes} scene blocks stitched into ${formatDuration(
          collected.reduce((sum, clip) => sum + clip.seconds, 0),
        )}.`,
      );
    },
    [pollRender, renderScene, syncShotToVocals, sliceAudioForShot],
  );

  /** Gemini writes the grade / lighting / lens direction for the chosen style. */
  const handleTuneStyle = async () => {
    setIsTuningStyle(true);
    try {
      const result = await tuneStyle({
        data: { styleMode, script, notes: moodBoard.notes ?? "" },
      });
      if (!result.ok) {
        showAiError(result.error);
        return;
      }
      updateMoodBoard({ ...moodBoard, notes: result.direction });
      toast.success("Style prompt tuned.");
    } catch {
      toast.error("Sign in to tune the visual style.");
    } finally {
      setIsTuningStyle(false);
    }
  };


  /**
   * Style-locked prompt set: the detected audio profile (tempo, length, song
   * structure) plus the lyric sheet drive one shared visual world. Free —
   * nothing renders and no V Tokens are charged.
   */
  const buildPrompts = useServerFn(generateTrackPromptSet);
  const handlePromptSet = useCallback(async () => {
    const lyrics = script.trim();
    if (lyrics.length < 10) {
      toast.error("Drop your song and add the lyrics or a breakdown first.");
      return;
    }
    setBuildingPrompts(true);
    setAiError(null);
    try {
      const result = await buildPrompts({
        data: {
          lyrics: lyrics.slice(0, 15000),
          styleMode,
          subjectMode,
          genreId: genreOverride === "auto" ? null : genreOverride,
          moodOverride: moodOverride.trim(),
          // Cost cap: 6–8 extended hero angles per project, never one prompt per bar.
          count: Math.max(6, Math.min(8, Math.round((audioTiming?.durationSeconds ?? duration) / 24))),

          track: {
            ...(audioName ? { name: audioName } : {}),
            bpm: audioTiming?.bpm ?? null,
            durationSeconds: audioTiming?.durationSeconds ?? duration,
            sections: (audioTiming?.sections ?? []).map(
              (s) =>
                `${s.label} ${Math.round(s.start)}-${Math.round(s.end)}s (energy ${s.energy.toFixed(2)})`,
            ),
          },
          ...(subjectMode !== "scenery" && hasCharacterProfile(character) ? { character } : {}),
        },
      });
      if (!result.ok) {
        setAiError(result.error);
        showAiError(result.error);
        return;
      }
      const { ok: _ok, ...set } = result;
      setPromptSet(set);
      toast.success("Style-locked prompt set ready — no V Tokens were used.");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The prompt set couldn't run. Try again.";
      setAiError(message);
      showAiError(message);
    } finally {
      setBuildingPrompts(false);
    }
  }, [
    audioName,
    audioTiming,
    buildPrompts,
    character,
    duration,
    genreOverride,
    moodOverride,
    script,
    styleMode,
    subjectMode,
  ]);

  // A fresh upload with a lyric sheet generates its prompt set on its own.
  // The trigger key is the uploaded track only — keying on `script.length`
  // fired a fresh AI pass on every keystroke in the lyric sheet. The handler
  // is held in a ref so its (correctly) changing identity can't re-run this.
  const autoPromptRef = useRef<string | null>(null);
  const promptSetFnRef = useRef(handlePromptSet);
  promptSetFnRef.current = handlePromptSet;
  const hasLyrics = script.trim().length >= 40;
  const autoPromptKey = audioTiming
    ? `${audioName ?? ""}|${audioTiming.durationSeconds}`
    : null;
  useEffect(() => {
    if (!autoPromptKey || !hasLyrics) return;
    if (autoPromptRef.current === autoPromptKey) return;
    autoPromptRef.current = autoPromptKey;
    void promptSetFnRef.current();
  }, [autoPromptKey, hasLyrics]);

  /** Free script pass: character profile + genre laws, no V Tokens charged. */

  const handleTestScript = async () => {
    if (!audioTiming && script.trim().length < 10) {
      toast.error("Drop your song or type a one-line idea first.");
      return;
    }
    setTestingScript(true);
    setAiError(null);
    try {
      const result = await writeScript({
        data: {
          mode: "write",
          styleMode,
          subjectMode,
          seed: [audioName ? `Track title: ${audioName}` : "", script.slice(0, 4000)]
            .filter(Boolean)
            .join("\n"),
          // The script box doubles as the lyric sheet, so the words of the song
          // travel to Gemini verbatim alongside the detected audio profile.
          lyrics: script.slice(0, 8000),
          genreId: genreOverride === "auto" ? null : genreOverride,
          ...(subjectMode !== "scenery" && hasCharacterProfile(character) ? { character } : {}),
          timing: audioTiming
            ? {
                durationSeconds: audioTiming.durationSeconds,
                bpm: audioTiming.bpm,
                cuts: audioTiming.cuts,
                sections: audioTiming.sections ?? [],
              }
            : null,
        },
      });
      if (!result.ok) {
        setAiError(result.error);
        showAiError(result.error);
        return;
      }
      setTestScript(result.script);
      toast.success("Test script ready — no V Tokens were used.");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The test script couldn't run. Try again.";
      setAiError(message);
      showAiError(message);
    } finally {
      setTestingScript(false);
    }
  };


  /**
   * Free concept step: builds the Video Moodboard (character close-ups,
   * environmental framing, style tags and the narrative block) before any
   * V Tokens are charged.
   */
  const handlePreviewConcept = async () => {
    if (script.trim().length < 40) {
      toast.error("Add a longer script before previewing the concept.");
      return;
    }
    setIsPreviewing(true);
    setAiError(null);
    try {
      const result = await buildCinematicConcept({
        data: {
          script,
          subjectMode,
          styleMode,
          durationSeconds: duration,
          genreId: genreOverride === "auto" ? null : genreOverride,
          moodOverride: moodOverride.trim(),
          track: {
            ...(audioName ? { name: audioName } : {}),
            bpm: audioTiming?.bpm ?? null,
            ...(audioTiming ? { durationSeconds: audioTiming.durationSeconds } : {}),
            sections: (audioTiming?.sections ?? []).map(
              (s) =>
                `${s.label} ${Math.round(s.start)}-${Math.round(s.end)}s (energy ${s.energy.toFixed(2)})`,
            ),
          },
          ...(subjectMode !== "scenery" && hasCharacterProfile(character)
            ? { character }
            : {}),
          moodBoard: {
            ...(moodBoard.grade ? { grade: moodBoard.grade } : {}),
            references: moodBoard.references ?? [],
            notes: (moodBoard.notes ?? "").trim(),
          },
        },
      });

      if (!result.ok) {
        setAiError(result.error);
        showAiError(result.error);
        return;
      }
      const { ok: _ok, ...preview } = result;
      setConcept(preview);
      toast.success("Concept preview ready — review it, then start generation.");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Sign in to preview your concept.";
      setAiError(message);
      showAiError(message);
    } finally {
      setIsPreviewing(false);
    }

  };


  const handleGenerate = async (scriptOverride?: string) => {
    const scriptText = (scriptOverride ?? script).trim();
    if (scriptText.length < 40) {
      toast.error("Add a longer script before rendering.");
      return;
    }
    // Pre-flight gate: a corrupt, silent or truncated master is caught here,
    // before a single paid render or lip-sync call is dispatched.
    if (audioFile) {
      const check = audioCheck?.fileName === audioFile.name && audioCheck.bytes === audioFile.size
        ? audioCheck
        : await preflightAudio(audioFile);
      setAudioCheck(check);
      if (!check.ok) {
        toast.error(check.blocking[0] ?? "The master track failed pre-flight.");
        return;
      }
    }
    cancelRef.current = false;
    activeJobRef.current = null;
    const startedAt = Date.now();
    // Rough ETA model: renders track ~3x the requested runtime, floor 90s.
    const estimatedTotal = Math.max(90, duration * 3);
    render.start("Parsing script into scene blocks…");
    markRunStart();
    setVideoUrl(null);
    setScenes([]);
    setClips([]);
    setLipSyncedIndexes([]);
    runCtxRef.current = null;

    setProgress({
      phase: "script",
      phaseState: "active",
      percent: 2,
      engine: null,
      scenes: [],
      startedAt,
      etaSeconds: estimatedTotal,
    });
    try {
      // The server recomputes the token cost from the duration — the browser
      // never gets to say how many V Tokens this render costs.
      const refPhotos =
        subjectMode !== "scenery" && characterPhoto ? [characterPhoto] : [];

      const started = await startRender({
        data: {
          script: scriptText,
          subjectMode,
          styleMode,
          durationSeconds: duration,
          characterPhotos: refPhotos,
          ...(subjectMode !== "scenery" && hasCharacterProfile(character)
            ? { character }
            : {}),
          moodBoard: {
            ...(moodBoard.grade ? { grade: moodBoard.grade } : {}),
            references: moodBoard.references ?? [],
            notes: (moodBoard.notes ?? "").trim(),
          },
          genreOverride: genreOverride === "auto" ? null : genreOverride,
          moodOverride,
          // The uploaded track always drives the scene plan, whatever the
          // subject mode — genre, tempo and structure come from the song.
          ...(audioTiming ? { audioTiming } : {}),
        },
      });

      if (!started.ok) {
        render.fail(started.error);
        toast.error(started.error);
        if (typeof started.balance === "number") setVBalance(started.balance);
        setProgress((prev) =>
          prev ? { ...prev, phaseState: "failed", note: started.error } : prev,
        );
        return;
      }
      render.connected("Rendering scene blocks…");
      setVBalance(started.balance);
      window.dispatchEvent(new Event("hybrid:v-tokens-changed"));
      // Snap the planned cut points onto the downbeats detected in the
      // rhythmic stem so picture cuts land on the track's real bar grid.
      const grid = getStemState().grid;
      const masterSeconds = audioTiming?.durationSeconds ?? started.seconds;
      const snapped = grid
        ? snapDurationsToDownbeats(
            started.scenes.map((scene) => scene.seconds),
            grid,
            masterSeconds,
          )
        : null;
      const plannedScenes =
        snapped && snapped.length === started.scenes.length
          ? started.scenes.map((scene, i) => ({ ...scene, seconds: snapped[i] ?? scene.seconds }))
          : started.scenes;
      setScenes(plannedScenes);
      setLogline(started.logline);
      toast.success(
        started.granted
          ? `Beta test render started — ${formatDuration(started.seconds)}, no V Tokens charged.`
          : `Charged ${started.charged} V Token${started.charged === 1 ? "" : "s"} for ${formatDuration(started.seconds)} of render.`,
      );


      if (started.genreLabel) {
        toast.message(`Genre visual laws locked: ${started.genreLabel}.`);
      }

      if (started.engine === "backup") {
        toast.message("Switched to V Engine Backup to keep this render moving.");
      }

      // The plan is kept so a failed block can be retried without paying again.
      runCtxRef.current = {
        scenes: plannedScenes,
        refPhotos,
        genreId: started.genreId,
        startedAt,
        estimatedTotal,
        states: plannedScenes.map(() => "pending" as SceneProgress["state"]),
        clips: [],
      };

      await runBlocks({ jobId: started.jobId, engine: started.engine });
    } catch {
      render.fail("Sign in to render with V Tokens.");
      toast.error("Sign in to render with V Tokens.");
      setProgress(null);
    } finally {
      render.settle();
    }
  };

  /**
   * One-click retry: re-renders only the blocks that failed or never started.
   * Memoised so the progress panel keeps a stable `onRetry` identity and its
   * React.memo actually holds while the render clock ticks.
   */
  const handleRetryBlocks = useCallback(async () => {
    if (!runCtxRef.current || renderRef.current.busy) return;
    const ctx = runCtxRef.current;
    cancelRef.current = false;
    activeJobRef.current = null;
    ctx.states = ctx.states.map((state) => (state === "done" ? "done" : "pending"));
    ctx.startedAt = Date.now();
    render.retry("Retrying unfinished scene blocks…");
    recordReconnect("render-retry", "Retrying unfinished scene blocks");
    try {
      await runBlocks();
    } catch {
      toast.error("Retry failed. Try again in a moment.");
      renderRef.current.fail("Retry failed. Try again in a moment.");
    } finally {
      renderRef.current.settle();
    }
  }, [render, runBlocks]);

  /**
   * Stable retry handler for the memoised progress panel: only its
   * availability (not the parent's per-second clock) changes its identity.
   */
  const retryHandler = useMemo(
    () => (canRetry && runCtxRef.current ? () => void handleRetryBlocks() : undefined),
    [canRetry, handleRetryBlocks],
  );

  /**
   * Resume: picks the sequence back up from the last completed checkpoint.
   * Same guarantee as retry — finished blocks and V Tokens are never re-spent —
   * but it is also available after an interruption that never reported a
   * failure (tab closed, navigation, upstream drop mid-poll).
   */
  const resumeHandler = useMemo(
    () =>
      !isGenerating && runCtxRef.current?.states.some((state) => state !== "done")
        ? () => void handleRetryBlocks()
        : undefined,
    [isGenerating, handleRetryBlocks],
  );

  /**
   * Immediate cancel: stops the client loop at the next checkpoint and
   * terminates the pending prediction upstream so no further compute is billed.
   */
  const handleCancelRender = useCallback(async () => {
    cancelRef.current = true;
    setCanceling(true);
    const jobId = activeJobRef.current;
    try {
      if (jobId) {
        const result = await cancelRender({ data: { jobId } });
        console.log("[cinematic] cancel dispatched", { jobId, result });
      }
      toast.message("Cancelling — the active block is being stopped.");
    } catch (err) {
      console.error("[cinematic] cancel failed", err);
      toast.error("Couldn't reach the engine to cancel — the local run is stopping anyway.");
    } finally {
      activeJobRef.current = null;
      setCanceling(false);
    }
  }, [cancelRender]);

  /**
   * Downloadable run manifest: final media links, every scene prompt and the
   * timestamp map, so a delivered render is fully reproducible off-platform.
   */
  const handleExportManifest = useCallback(() => {
    let cursor = 0;
    const shots = scenes.map((scene) => {
      const start = cursor;
      cursor += scene.seconds;
      const clip = clips.find((c) => c.index === scene.index);
      return {
        index: scene.index,
        title: scene.title,
        prompt: scene.shot,
        startSeconds: start,
        endSeconds: cursor,
        seconds: scene.seconds,
        vocalSync: Boolean(scene.vocalSync),
        lipSynced: lipSyncedIndexes.includes(scene.index),
        mediaUrl: clip?.url ?? null,
      };
    });
    const manifest = {
      project: "Hybrid AI Records LLC — Visual Engine",
      producer: PRODUCER_NAME,
      generatedAt: new Date().toISOString(),
      logline,
      style: styleMode,
      subjectMode,
      genre: genreOverride,
      durationSeconds: cursor,
      track: { name: audioName, durationSeconds: audioTiming?.durationSeconds ?? null, bpm: audioTiming?.bpm ?? null },
      master: clips[0]?.url ?? videoUrl ?? null,
      shots,
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `hybrid-cinematic-manifest-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success("Manifest exported.");
  }, [
    audioName,
    audioTiming,
    clips,
    genreOverride,
    lipSyncedIndexes,
    logline,
    scenes,
    styleMode,
    subjectMode,
    videoUrl,
  ]);

  /**
   * Stable entry points for the memoised panels. The underlying handlers are
   * redefined on every render (they read live state), so they are held in refs
   * and invoked through identities that never change — the panels then repaint
   * only when their own data changes instead of remounting.
   */
  const previewConceptRef = useRef(handlePreviewConcept);
  previewConceptRef.current = handlePreviewConcept;
  const generateRef = useRef(handleGenerate);
  generateRef.current = handleGenerate;

  /**
   * One & done: validate the master, run Gemini orchestration, dispatch the
   * live render and let the player mux the audio — no manual station clicks.
   */
  const runAutoPipeline = async (mode: IngestMode, idea: string) => {
    if (!audioFileRef.current || !audioTiming) {
      toast.error("Drop your track first.");
      return;
    }
    setAutoPhase("running");
    setAiError(null);
    try {
      // Station 1 — validate the master and hold its timestamps.
      setAutoStage({ label: "Analyzing track…", percent: 8 });
      const check = await preflightAudio(audioFileRef.current);
      setAudioCheck(check);
      if (!check.ok) {
        const reason = check.blocking[0] ?? "The master track failed pre-flight.";
        setAutoStage({ label: reason, percent: 8, failed: true });
        toast.error(reason);
        setAutoPhase("idle");
        return;
      }

      // Station 2 — Gemini orchestration in the background.
      setAutoStage({ label: "Writing the shot script…", percent: 18 });
      if (idea) setScript(idea);
      const written = await writeScript({
        data: {
          mode,
          styleMode,
          subjectMode,
          seed: [audioName ? `Track title: ${audioName}` : "", idea].filter(Boolean).join("\n"),
          lyrics: (mode === "analyze" ? script : idea).slice(0, 8000),
          genreId: genreOverride === "auto" ? null : genreOverride,
          ...(subjectMode !== "scenery" && hasCharacterProfile(character) ? { character } : {}),
          timing: {
            durationSeconds: audioTiming.durationSeconds,
            bpm: audioTiming.bpm,
            cuts: audioTiming.cuts,
            sections: audioTiming.sections ?? [],
          },
        },
      });
      if (!written.ok) {
        setAiError(written.error);
        setAutoStage({ label: written.error, percent: 18, failed: true });
        showAiError(written.error);
        setAutoPhase("idle");
        return;
      }
      console.log("[cinematic] auto pipeline script ready", { mode, chars: written.script.length });
      setScript(written.script);

      // Stations 3 & 4 — live dispatch; the master player muxes on completion.
      setAutoStage({ label: "Generating scenes…", percent: 25 });
      await generateRef.current(written.script);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The studio couldn't finish this run.";
      console.error("[cinematic] auto pipeline failed", err);
      setAutoStage({ label: message, percent: 100, failed: true });
      toast.error(message);
      setAutoPhase("idle");
    }
  };

  const autoPipelineRef = useRef(runAutoPipeline);
  autoPipelineRef.current = runAutoPipeline;
  const launchAutoPipeline = useCallback(
    (mode: IngestMode, idea: string) => void autoPipelineRef.current(mode, idea),
    [],
  );

  // The single bar tracks the live render once dispatch takes over.
  useEffect(() => {
    if (autoPhase !== "running" || !progress) return;
    const percent = 25 + Math.max(0, Math.min(100, progress.percent)) * 0.7;
    const label =
      progress.phaseState === "failed"
        ? (progress.note ?? "The render stopped.")
        : progress.phase === "script"
          ? "Orchestrating scenes…"
          : "Generating video…";
    setAutoStage({ label, percent, failed: progress.phaseState === "failed" });
  }, [autoPhase, progress]);

  // Completion: the film is welded and muxed inside the player from here.
  useEffect(() => {
    if (autoPhase !== "running" || isGenerating) return;
    if (clips.length > 0) {
      setAutoStage({ label: "Muxing audio…", percent: 100 });
      setAutoPhase("done");
    } else if (progress?.phaseState === "failed") {
      setAutoPhase("idle");
    }
  }, [autoPhase, isGenerating, clips.length, progress]);

  // Master button gate: a stored track plus performer details (or scenery mode).
  const masterReady =
    Boolean(audioTiming && audioFile) &&
    (subjectMode === "scenery" || hasCharacterProfile(character));


  const buildConcept = useCallback(() => void previewConceptRef.current(), []);
  const startRenderRun = useCallback(() => void generateRef.current(), []);
  const generatePromptSet = useCallback(() => void promptSetFnRef.current(), []);
  const editConcept = useCallback(() => {
    setConcept(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);



  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        <PortalBreadcrumb trail={[{ label: "Visual Engine" }]} />
        <StudioStageNav />

        {/* Header with publish toggle */}
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <Film className="size-6 text-primary" aria-hidden />
                Visual Engine
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
                  isPublished
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-muted text-muted-foreground"
                }`}
              >
                {isPublished ? (
                  <Globe className="size-3.5" aria-hidden />
                ) : (
                  <Lock className="size-3.5" aria-hidden />
                )}
                {isPublished ? "Live & Published" : "Locked in Development"}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              V Engine pipeline • $12.50 per V Token (1 min) • zero manual editing
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-sm font-semibold"
              aria-live="polite"
            >
              <HybridTokenIcon className="size-4 text-primary" aria-hidden />
              {signedIn ? (vBalance ?? "—") : 0} V Tokens
            </span>
            <Button asChild variant="outline">
              <Link to="/v-tokens">Buy V Tokens</Link>
            </Button>
            <Button
              type="button"
              variant={isPublished ? "default" : "secondary"}
              onClick={() => setIsPublished((v) => !v)}
            >
              {isPublished ? "Unpublish Page" : "Publish to Production"}
            </Button>
          </div>
        </div>

        {/* Development lock notice */}
        {!isPublished && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-4">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Lock className="size-4 shrink-0" aria-hidden />
              Development mode active: this page is locked from public visibility. Test your
              pipeline below before publishing live.
            </p>
            <span className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              Internal only
            </span>
          </div>
        )}

        {/* Stage 1 — audio ingest. Storage only; no API calls fire here. */}
        {autoPhase !== "done" && (
          <Card id="stage-audio" className="scroll-mt-24">
            <CardHeader>
              <CardTitle className="text-lg">Stage 1 — Drop my track</CardTitle>
              <CardDescription>
                Drop your song. It is validated and held in memory for the render — generation
                only starts when you press Generate Master Video.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {autoPhase === "running" && autoStage ? (
                <AutoPipelineBar stage={autoStage} />
              ) : (
                <OneClickIngest
                  timing={audioTiming}
                  fileName={audioName}
                  onTiming={handleTiming}
                  disabled={isGenerating}
                />
              )}
            </CardContent>
          </Card>
        )}



        {/* Finished film: full-width playback, download and manifest. */}
        {autoPhase === "done" && clips.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{audioName ?? "Your film"}</CardTitle>
              <CardDescription>Ready for instant playback and download.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <CinematicMasterPlayer clips={clips} audioUrl={audioUrl} audioFile={audioFile} masterSeconds={audioTiming?.durationSeconds ?? null} />
              <ShotAudioTimeline
                blocks={scenes.map((scene) => ({
                  index: scene.index,
                  title: scene.title,
                  seconds: scene.seconds,
                  url: clips.find((c) => c.index === scene.index)?.url ?? null,
                }))}
                timing={audioTiming}
                trackName={audioName}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Button type="button" variant="outline" onClick={handleExportManifest}>
                  <span className="flex items-center gap-2">
                    <Download className="size-4" aria-hidden /> Export run manifest
                  </span>
                </Button>
                <Button type="button" variant="secondary" onClick={() => setAutoPhase("idle")}>
                  Start a new film
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left: inputs */}
          <div className="space-y-6 lg:col-span-2">
            <Card id="stage-character" className="scroll-mt-24">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <UserPlus className="size-5 text-primary" aria-hidden />
                  Stage 2 — Character Builder
                </CardTitle>
                <CardDescription>
                  Required. Define the performer once — the name, look and photo are injected into
                  every shot as the visual anchor.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-medium">Scene subject</p>
                  <Select value={subjectMode} onValueChange={setSubjectMode}>
                    <SelectTrigger className="w-[190px]" aria-label="Scene subject mode">
                      <SelectValue placeholder="Select mode" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="people">People</SelectItem>
                      <SelectItem value="scenery">Scenery only</SelectItem>
                      <SelectItem value="story">Story (cut to a song)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {subjectMode !== "scenery" && (
                  <CharacterAnchorFrame character={hasCharacterProfile(character) ? character : null} />
                )}

                {subjectMode !== "scenery" && (
                  <CharacterBuilder
                    trackTitle={audioName ?? ""}
                    genre={genreOverride === "auto" ? "" : genreOverride}
                    styleMode={styleMode}
                    notes={script.slice(0, 800)}
                    value={character}
                    onChange={handleCharacterChange}
                    disabled={isGenerating}
                  />
                )}
              </CardContent>
            </Card>

            <Card id="stage-script" className="scroll-mt-24">
              <CardHeader>
                <CardTitle className="text-lg">Stage 3 — Scene direction</CardTitle>
                <CardDescription>
                  The visual narrative prompt. The AI reads the track's tempo, structure and beats,
                  then writes the shot script synced to every cut.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <ScriptComposer
                  script={script}
                  onScript={setScript}
                  timing={audioTiming}
                  audioName={audioName}
                  styleMode={styleMode}
                  subjectMode={subjectMode}
                  maxScript={MAX_SCRIPT}
                  disabled={isGenerating}
                  onTiming={handleTiming}
                />
              </CardContent>

            </Card>

            <BeatBlockBuilder
              styleMode={styleMode}
              subjectMode={subjectMode}
              genreId={genreOverride === "auto" ? null : genreOverride}
              referenceImage={character.referenceImage ?? undefined}
              bpm={audioTiming?.bpm ?? null}
              sliceAudio={sliceAudioForShot}
              disabled={isGenerating}
            />


            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Style-locked prompt set</CardTitle>
                <CardDescription>
                  Built automatically from the uploaded track — its detected tempo, structure and
                  lyrics — with one locked world, wardrobe and grade across every shot.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TrackPromptSet
                  set={promptSet}
                  loading={buildingPrompts}
                  disabled={isGenerating}
                  trackName={audioName}
                  onGenerate={generatePromptSet}
                />
              </CardContent>
            </Card>


            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Palette className="size-5 text-primary" aria-hidden />
                  Visual style
                </CardTitle>
                <CardDescription>
                  Pick the look, then let the AI tune the exact grade, lighting and lens language.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Select value={styleMode} onValueChange={setStyleMode}>
                  <SelectTrigger id="cine-style" className="w-full" aria-label="Visual style">
                    <SelectValue placeholder="Select style" />
                  </SelectTrigger>
                  <SelectContent className="max-h-80">
                    {STYLE_GROUPS.map((group) => (
                      <SelectGroup key={group.id}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {group.styles.map((style) => (
                          <SelectItem key={style.id} value={style.id}>
                            {style.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={isGenerating || isTuningStyle}
                  onClick={() => void handleTuneStyle()}
                >
                  {isTuningStyle ? (
                    <Wand2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="size-4" aria-hidden />
                  )}
                  {isTuningStyle ? "Tuning the look…" : "Style Prompt Tuning"}
                </Button>

                <div className="space-y-2 rounded-lg border border-border bg-muted/10 p-3">
                  <Label htmlFor="cine-genre" className="text-xs uppercase tracking-wide">
                    Genre visual laws
                  </Label>
                  <Select value={genreOverride} onValueChange={setGenreOverride}>
                    <SelectTrigger
                      id="cine-genre"
                      className="w-full"
                      aria-label="Genre used for storyboard prompts"
                    >
                      <SelectValue placeholder="Auto-detect from the song" />
                    </SelectTrigger>
                    <SelectContent className="max-h-80">
                      <SelectItem value="auto">Auto-detect from the song</SelectItem>
                      {GENRE_LAWS.map((law) => (
                        <SelectItem key={law.id} value={law.id}>
                          {law.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Label htmlFor="cine-mood" className="text-xs uppercase tracking-wide">
                    Mood override
                  </Label>
                  <Input
                    id="cine-mood"
                    value={moodOverride}
                    onChange={(e) => setMoodOverride(e.target.value)}
                    maxLength={120}
                    placeholder="e.g. defiant, sunburnt, melancholy"
                    aria-label="Mood used for storyboard prompts"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave on auto to let the detected genre and mood drive the 33-shot storyboard.
                  </p>
                </div>

                {(moodBoard.notes ?? "").trim() && (
                  <p className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                    {moodBoard.notes}
                  </p>
                )}
              </CardContent>
            </Card>

            <VideoMoodboard
              disabled={isGenerating}
              busy={isGenerating}
              building={isPreviewing}
              concept={concept}
              character={subjectMode !== "scenery" ? character : null}
              costLabel={`${vTokens} V-Token${vTokens > 1 ? "s" : ""} ($${totalCost})`}
              onBuild={buildConcept}
              onEdit={editConcept}
              onStart={startRenderRun}
            />



          </div>

          {/* Right: settings + execution */}
          <div id="stage-render" className="scroll-mt-24 space-y-6">
            <AiErrorNotice error={aiError} />


            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Sparkles className="size-5 text-primary" aria-hidden />
                  Test script
                </CardTitle>
                <CardDescription>
                  Free preview — runs the AI script pass with your character profile and Genre
                  Visual Laws. No V Tokens are used.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={testingScript || isGenerating}
                  onClick={() => void handleTestScript()}
                >
                  {testingScript ? (
                    <Wand2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="size-4" aria-hidden />
                  )}
                  {testingScript ? "Writing the test script…" : "Run Test Script"}
                </Button>
                {testScript ? (
                  <div className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-3 text-xs leading-relaxed">
                    {testScript}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Drop a song or type an idea, set your character, then run a free test pass.
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Sliders className="size-5 text-primary" aria-hidden />
                  Video length &amp; render
                </CardTitle>
                <CardDescription>Set the runtime, then preview your concept.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">


                <div className="space-y-3 border-t border-border pt-4">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium" htmlFor="cine-duration">
                      Video length
                    </label>
                    <span className="text-sm font-bold text-primary">
                      {formatDuration(duration)}
                    </span>
                  </div>
                  <Slider
                    id="cine-duration"
                    aria-label="Video length"
                    min={MIN_DURATION}
                    max={MAX_DURATION}
                    step={DURATION_STEP}
                    value={[duration]}
                    onValueChange={(vals: number[]) => setDuration(vals[0])}
                  />
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>0:30</span>
                    <span>1:00 = 1 V Token</span>
                    <span>14:00</span>
                  </div>
                  {duration > V_TOKEN_SECONDS && (
                    <p className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-xs text-primary">
                      Billed per minute, rounded up — this {formatDuration(duration)} render uses{" "}
                      {vTokens} V Tokens.
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-border pt-4">
                  <div>
                    <p className="text-sm font-medium">V Token cost</p>
                    <p className="text-xs font-bold text-primary">
                      {vTokens} V Token{vTokens > 1 ? "s" : ""} • ${totalCost}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      $12.50 per V Token (1 min of V Engine render, rounded up)
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Compute cost</p>
                    <p className="text-xs text-muted-foreground">{"<"} $1.00</p>
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3 text-xs">
                  <span className="text-muted-foreground">Your balance</span>
                  <span className="font-semibold">
                    {signedIn ? `${vBalance ?? "—"} V Token${vBalance === 1 ? "" : "s"}` : "Sign in"}
                  </span>
                </div>

                {signedIn && shortBy > 0 ? (
                  <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
                    <p className="text-xs text-muted-foreground">
                      This render costs {vTokens} V Token{vTokens > 1 ? "s" : ""} and you have{" "}
                      {vBalance ?? 0}.{" "}
                      {V_RENDER_BETA
                        ? "Beta test renders still run — you won't be charged for the shortfall."
                        : `Top up ${shortBy} more to continue.`}
                    </p>
                    <Button asChild size="sm" variant="outline" className="w-full">
                      <Link to="/v-tokens">Buy V Tokens</Link>
                    </Button>
                  </div>
                ) : !signedIn ? (
                  <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                    <Link to="/auth" className="font-semibold text-primary underline">
                      Sign in
                    </Link>{" "}
                    to see your V Token balance and buy more.
                  </p>
                ) : V_RENDER_BETA ? (
                  <p className="rounded-lg border border-border bg-muted/20 p-3 text-[11px] text-muted-foreground">
                    {V_BETA_NOTICE}
                  </p>
                ) : null}

                <Button
                  type="button"
                  onClick={() => (concept ? void handleGenerate() : void handlePreviewConcept())}
                  disabled={isGenerating || isPreviewing || (!V_RENDER_BETA && shortBy > 0)}
                  className="w-full py-6 font-semibold"
                >

                  {isGenerating ? (
                    <span className="flex items-center gap-2">
                      <Wand2 className="size-5 animate-spin" aria-hidden />{" "}
                      {stage ?? "Orchestrating pipeline…"}
                    </span>
                  ) : isPreviewing ? (
                    <span className="flex items-center gap-2">
                      <Wand2 className="size-5 animate-spin" aria-hidden /> Building your Video
                      Moodboard…
                    </span>
                  ) : concept ? (
                    <span className="flex items-center gap-2">
                      <Sparkles className="size-5" aria-hidden /> Start Generation —{" "}
                      {formatDuration(duration)} master, {vTokens} V Token{vTokens > 1 ? "s" : ""}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <ImageIcon className="size-5" aria-hidden /> Preview concept — free
                    </span>
                  )}

                </Button>

                {!concept && !isGenerating && (
                  <p className="text-center text-[11px] text-muted-foreground">
                    Concept preview is free — V Tokens are only charged when you hit Start
                    Generation.
                  </p>
                )}



                {progress && (
                  <CinematicRenderProgress
                    progress={progress}
                    retrying={isGenerating}
                    onRetry={retryHandler}
                    onResume={resumeHandler}
                  />
                )}

                {scenes.length > 0 && (
                  <ShotAudioTimeline
                    blocks={scenes.map((scene) => ({
                      index: scene.index,
                      title: scene.title,
                      seconds: scene.seconds,
                      url: clips.find((c) => c.index === scene.index)?.url ?? null,
                    }))}
                    timing={audioTiming}
                    trackName={audioName}
                  />
                )}


                {clips.length > 0 && <CinematicMasterPlayer clips={clips} audioUrl={audioUrl} audioFile={audioFile} masterSeconds={audioTiming?.durationSeconds ?? null} />}

                {clips.length > 0 && (
                  <Button type="button" variant="outline" className="w-full" onClick={handleExportManifest}>
                    <span className="flex items-center gap-2">
                      <Download className="size-4" aria-hidden /> Export run manifest (JSON)
                    </span>
                  </Button>
                )}

                {clips.length > 0 && (
                  <SyncAccuracyReport
                    blocks={scenes.map((scene) => ({
                      index: scene.index,
                      title: scene.title,
                      seconds: scene.seconds,
                      ...(scene.vocalSync ? { vocalSync: true } : {}),
                    }))}
                    timing={audioTiming}
                    lipSyncedIndexes={lipSyncedIndexes}
                    trackName={audioName}
                  />
                )}


                {scenes.length > 0 && (
                  <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                    {logline && <p className="text-xs text-muted-foreground">{logline}</p>}
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Scene blocks ({scenes.length})
                    </p>
                    <ol className="space-y-1 text-xs text-muted-foreground">
                      {scenes.slice(0, 12).map((scene) => (
                        <li key={scene.index}>
                          <span className="font-semibold text-foreground">{scene.title}</span> —{" "}
                          {scene.shot.slice(0, 140)}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                <p className="flex items-center justify-center gap-2 pt-1 text-[11px] text-muted-foreground">
                  <ShieldCheck className="size-4 text-primary" aria-hidden />
                  Zero manual editing required • glitch-free guarantee
                </p>

              </CardContent>
            </Card>
          </div>
        </div>

        {/* Master execution — the only entry point into the render pipeline. */}
        {autoPhase !== "running" && (
          <Card className="border-primary/40">
            <CardContent className="space-y-3 p-5">
              <Button
                type="button"
                className="w-full py-7 text-base font-bold"
                disabled={!masterReady || isGenerating}
                onClick={() => launchAutoPipeline("analyze", script)}
              >
                <span className="flex items-center gap-2">
                  <Sparkles className="size-5" aria-hidden /> Generate Master Video
                </span>
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                {masterReady
                  ? "Renders the performance on Replicate, muxes your master audio locally, then opens the player with a Download MP4 button."
                  : "Load a track in Stage 1 and fill in the performer details in Stage 2 to unlock the render."}
              </p>
            </CardContent>
          </Card>
        )}

      </div>
      {showRenderStats && <RenderDebugOverlay defaultOpen={debugOpen} />}
    </div>
  );
}
