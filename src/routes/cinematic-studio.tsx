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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
import { CinematicMasterPlayer, type MasterClip } from "@/components/CinematicMasterPlayer";
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
import { VideoStudio } from "@/components/VideoStudio";
import {
  characterDescriptionFor,
  hiddenStyleDirection,
  personaById,
  presetById,
  scriptSeed,
  timelineMarkersFromSections,
  type ProductionMode,
  type VideoStyleId,
} from "@/lib/video-studio";

const TITLE = "Video Studio — Hybrid AI Records";
const DESCRIPTION = "Drop a track, choose a mode and a style, and generate one music video.";

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
  const [productionMode, setProductionMode] = useState<ProductionMode>("auto");
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [styleId, setStyleId] = useState<VideoStyleId | null>(null);
  const [customText, setCustomText] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [characterImage, setCharacterImage] = useState<string | null>(null);
  const [characterImageName, setCharacterImageName] = useState<string | null>(null);
  const [vocalName, setVocalName] = useState<string | null>(null);
  const [studioNote, setStudioNote] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportExt, setExportExt] = useState("mp4");
  const vocalBufferRef = useRef<AudioBuffer | null>(null);
  const vocalFileRef = useRef<File | null>(null);
  const stitchedKey = useRef<string | null>(null);

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
    {
      index: number;
      title: string;
      shot: string;
      stillPrompt?: string;
      seconds: number;
      vocalSync?: boolean;
    }[]
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
    scenes: {
      index: number;
      title: string;
      shot: string;
      stillPrompt?: string;
      seconds: number;
      vocalSync?: boolean;
    }[];
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
      const source = vocalBufferRef.current;
      if (!source) return clipUrl;
      try {
        const { sliceToWav, toBase64 } = await import("@/lib/audio-slice");
        const wav = sliceToWav(source, startSeconds, seconds);
        const result = await lipsyncShot({
          data: { videoUrl: clipUrl, audioWavBase64: toBase64(wav), shotIndex },
        });
        if (result.ok) return result.videoUrl;
        console.error(`[cinematic] lip-sync failed on block ${shotIndex + 1}`, result.error);
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
      stitchedKey.current = null;
      setExportUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });

      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return file ? URL.createObjectURL(file) : null;
      });
      if (map) {
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
              ...(scene.stillPrompt ? { stillPrompt: scene.stillPrompt } : {}),
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
            console.error(`[cinematic] block ${i + 1}/${totalScenes} dispatch failed`, {
              status,
              error: dispatched.error,
              detail,
            });
            recordReconnect("render-dispatch", `block ${i + 1}: ${dispatched.error}`);
            blockError =
              detail && !dispatched.error.includes(detail)
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
            if (scene.vocalSync && vocalBufferRef.current) {
              const startSeconds = sceneShots.slice(0, i).reduce((sum, s) => sum + s.seconds, 0);
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
          count: Math.max(
            6,
            Math.min(8, Math.round((audioTiming?.durationSeconds ?? duration) / 24)),
          ),

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
  const autoPromptKey = audioTiming ? `${audioName ?? ""}|${audioTiming.durationSeconds}` : null;
  useEffect(() => {
    if (!autoPromptKey || !hasLyrics) return;
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
          ...(subjectMode !== "scenery" && hasCharacterProfile(character) ? { character } : {}),
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
      const message = err instanceof Error ? err.message : "Sign in to preview your concept.";
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
      const check =
        audioCheck?.fileName === audioFile.name && audioCheck.bytes === audioFile.size
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
    setStudioNote("Generating your music video…");
    try {
      const preset = presetById(styleId);
      const persona = productionMode === "character" ? personaById(personaId) : null;
      const profile = persona ? { ...persona.profile, referenceImage: characterImage } : null;
      const refPhotos = profile?.referenceImage ? [profile.referenceImage] : [];
      const modeSubject = productionMode === "auto" ? "scenery" : "people";
      const markers = audioTiming
        ? timelineMarkersFromSections(audioTiming.sections ?? [], audioTiming.durationSeconds)
        : [];

      const started = await startRender({
        data: {
          script: scriptText,
          subjectMode: modeSubject,
          styleMode: preset?.styleMode ?? "photorealistic",
          durationSeconds: duration,
          characterPhotos: refPhotos,
          ...(profile ? { character: profile } : {}),
          moodBoard: { references: [], notes: "" },
          genreOverride: preset?.genreId ?? null,
          moodOverride: (preset?.label ?? "Custom").slice(0, 120),
          styleDirection: hiddenStyleDirection(styleId, customText),
          lyrics,
          characterDescription: characterDescriptionFor(productionMode, personaId),
          lipsync: Boolean(vocalBufferRef.current),
          markers,
          ...(audioTiming ? { audioTiming } : {}),
        },
      });

      if (!started.ok) {
        render.fail(started.error);
        setStudioNote(started.error);
        if (typeof started.balance === "number") setVBalance(started.balance);
        setProgress((prev) =>
          prev ? { ...prev, phaseState: "failed", note: started.error } : prev,
        );
        return;
      }
      render.connected("Rendering scene blocks…");
      setVBalance(started.balance);
      window.dispatchEvent(new Event("hybrid:v-tokens-changed"));
      const plannedScenes = started.scenes;
      setScenes(plannedScenes);
      setLogline(started.logline);

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
      render.fail("Sign in to generate this video.");
      setStudioNote("Sign in to generate this video.");
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
      track: {
        name: audioName,
        durationSeconds: audioTiming?.durationSeconds ?? null,
        bpm: audioTiming?.bpm ?? null,
      },
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

  useEffect(() => {
    if (isGenerating || clips.length === 0 || !audioFile) return;
    const key = clips.map((clip) => clip.url).join("|");
    if (stitchedKey.current === key) return;
    stitchedKey.current = key;
    let cancelled = false;
    setStudioNote("Stitching your music video…");
    void (async () => {
      try {
        const { remuxMaster, canRemuxMaster } = await import("@/lib/ffmpeg-master");
        if (canRemuxMaster()) {
          const result = await remuxMaster(
            clips.map((clip) => clip.url),
            audioFile,
            undefined,
            "native",
            audioTiming?.durationSeconds,
          );
          if (cancelled) return;
          setExportExt(result.extension);
          setExportUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(result.blob);
          });
          setStudioNote("Your music video is ready.");
          return;
        }
        const { stitchMaster, canStitchMaster } = await import("@/lib/stitch-master");
        if (!audioUrl || !canStitchMaster()) {
          if (!cancelled)
            setStudioNote(
              "The shots are ready, but this browser couldn't stitch them into one file.",
            );
          return;
        }
        const welded = await stitchMaster(
          clips.map((clip) => clip.url),
          undefined,
          audioUrl,
        );
        if (cancelled) return;
        setExportExt(welded.extension);
        setExportUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(welded.blob);
        });
        setStudioNote("Your music video is ready.");
      } catch (err) {
        console.error("[video-studio] stitch failed", err);
        if (!cancelled) {
          setStudioNote("The shots rendered, but this browser couldn't stitch them into one file.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audioFile, audioTiming, audioUrl, clips, isGenerating]);

  const beginGenerate = async () => {
    if (!audioFileRef.current) {
      setStudioNote("Add a master track first.");
      return;
    }
    if (vocalFileRef.current) {
      try {
        const { decodeMaster } = await import("@/lib/audio-slice");
        const decoded = await decodeMaster(vocalFileRef.current);
        vocalBufferRef.current = decoded.buffer;
      } catch (err) {
        console.error("[video-studio] vocal stem decode failed", err);
        vocalBufferRef.current = null;
        setStudioNote("The vocal stem could not be read, so lip-sync will be skipped.");
      }
    } else {
      vocalBufferRef.current = null;
    }
    setExportUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setStudioNote("Generating your music video…");
    await handleGenerate(scriptSeed(styleId, customText, lyrics));
  };

  const onMasterFile = async (file: File | null) => {
    if (!file) {
      handleTiming(null, null, null);
      return;
    }
    const name = file.name.toLowerCase();
    if (!name.endsWith(".mp3") && !name.endsWith(".wav")) {
      setStudioNote("Upload a master MP3 or WAV.");
      return;
    }
    try {
      const { analyzeAudioTiming } = await import("@/lib/audio-timing");
      const map = await analyzeAudioTiming(file);
      handleTiming(map, file.name, file);
      setStudioNote(null);
    } catch (err) {
      setStudioNote(err instanceof Error ? err.message : "Couldn't read that track.");
    }
  };

  const onVocalFile = (file: File | null) => {
    vocalFileRef.current = file;
    vocalBufferRef.current = null;
    if (!file) {
      setVocalName(null);
      return;
    }
    const name = file.name.toLowerCase();
    if (!name.endsWith(".mp3") && !name.endsWith(".wav")) {
      vocalFileRef.current = null;
      setVocalName(null);
      setStudioNote("Upload a vocal stem as MP3 or WAV.");
      return;
    }
    setVocalName(file.name);
    setStudioNote(null);
  };

  const onCharacterImage = (file: File | null) => {
    if (!file) {
      setCharacterImage(null);
      setCharacterImageName(null);
      return;
    }
    const name = file.name.toLowerCase();
    const png = file.type === "image/png" || name.endsWith(".png");
    const jpg = file.type === "image/jpeg" || name.endsWith(".jpg") || name.endsWith(".jpeg");
    if (!png && !jpg) {
      setStudioNote("Use a PNG or JPG character image.");
      return;
    }
    if (file.size > 3_000_000) {
      setStudioNote("That character image is too large.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      if (!/^data:image\/(png|jpeg);base64,/i.test(url)) {
        setStudioNote("Use a PNG or JPG character image.");
        return;
      }
      setCharacterImage(url);
      setCharacterImageName(file.name);
      setStudioNote(null);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <VideoStudio
        audioName={audioName}
        vocalName={vocalName}
        mode={productionMode}
        personaId={personaId}
        styleId={styleId}
        customText={customText}
        lyrics={lyrics}
        characterImageName={characterImageName}
        busy={isGenerating}
        status={studioNote}
        exportUrl={exportUrl}
        exportName={`hybrid-music-video.${exportExt}`}
        onMasterFile={(file) => void onMasterFile(file)}
        onVocalFile={onVocalFile}
        onMode={setProductionMode}
        onPersona={setPersonaId}
        onStyle={setStyleId}
        onCustomText={setCustomText}
        onLyrics={setLyrics}
        onCharacterImage={onCharacterImage}
        onGenerate={() => void beginGenerate()}
      />
    </div>
  );
}
