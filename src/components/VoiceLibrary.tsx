import { hasSupabaseSession } from "@/lib/has-session";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mic,
  Check,
  Copy,
  GitCompare,

  Pencil,
  RotateCcw,
  Square,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VocalLiabilityModal } from "@/components/VocalLiabilityModal";
import { useVocalLiability } from "@/hooks/use-vocal-liability";
import { ACTIVE_VOICE_KEY, notifyActiveVoiceChange } from "@/lib/active-voice";
import { readStoredVocalConsent } from "@/lib/vocal-consent";
import { usePersistentState } from "@/lib/studio-persist";
import { uploadVoiceSample, VOICE_CAPTURE_CONSTRAINTS, VOICE_SAMPLE_ACCEPT } from "@/lib/voice-sample-upload";
import { ClipMetadataPanel } from "@/components/ClipMetadataPanel";
import { ClipMetadataDiff } from "@/components/ClipMetadataDiff";

import { WaveformPreview } from "@/components/WaveformPreview";
import { buildClipAnalysisReport, downloadReport } from "@/lib/voice-analysis-report";
import { MAX_SECONDS, TARGET_SECONDS, trimVoiceSample } from "@/lib/voice-sample-trim";
import { analyseVoiceSample, toDb, type SampleQuality } from "@/lib/voice-sample-quality";
import {
  deleteVoiceProfile,
  getVoiceCloneJob,
  listVoiceProfiles,
  parseVoiceProfileSaveError,
  renameVoiceProfile,
  saveVoiceProfile,
  startVoiceCloneJob,
  type VoiceProfile,
} from "@/lib/voice-library.functions";

const RECORD_SECONDS = 10;
const POLL_MS = 3000;
const MAX_POLLS = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** m:ss readout for trim selections. */
function formatClock(seconds: number) {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

type ClonePhase = "idle" | "uploading" | "cloning" | "saving" | "done" | "error";

type CloneProgress = {
  phase: ClonePhase;
  percent: number;
  message: string;
  detail?: string;
};

const IDLE_PROGRESS: CloneProgress = { phase: "idle", percent: 0, message: "" };

export function VoiceLibrary() {
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [label, setLabel] = useState("");
  const [sample, setSample] = useState<{ file: File; url: string; source: number } | null>(null);
  const [source, setSource] = useState<{ file: File; url: string; duration: number } | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [quality, setQuality] = useState<SampleQuality | null>(null);
  const [checking, setChecking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Saved clip whose metadata diff is expanded. */
  const [diffId, setDiffId] = useState<string | null>(null);

  const [editingLabel, setEditingLabel] = useState("");
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(RECORD_SECONDS);
  const [busy, setBusy] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const { modalOpen, runOrPrompt, handleAccepted, handleOpenChange } =
    useVocalLiability(setTermsAccepted);
  const [progress, setProgress] = useState<CloneProgress>(IDLE_PROGRESS);
  const [activeVoiceId, setActiveVoiceId] = usePersistentState<string>(ACTIVE_VOICE_KEY, "");
  const [dragging, setDragging] = useState(false);
  const [sortBy, setSortBy] = usePersistentState<string>(
    "hybrid:voice-library:sort",
    "newest",
  );
  const [qualityFilter, setQualityFilter] = usePersistentState<string>(
    "hybrid:voice-library:filter",
    "all",
  );

  const fileRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const dragDepth = useRef(0);
  const appliedStart = useRef(0);

  /** Clips filtered + sorted by their stored clipping / silence analysis. */
  const visibleVoices = useMemo(() => {
    const clipBars = (v: VoiceProfile) => v.clip_bars ?? 0;
    const silenceBars = (v: VoiceProfile) => v.silence_bars ?? 0;
    const filtered = voices.filter((voice) => {
      switch (qualityFilter) {
        case "clipping":
          return clipBars(voice) > 0;
        case "silence":
          return silenceBars(voice) > 0;
        case "violations":
          return clipBars(voice) > 0 || silenceBars(voice) > 0;
        case "clean":
          return clipBars(voice) === 0 && silenceBars(voice) === 0;
        case "flagged":
          return voice.quality_blocked === true;
        case "unanalysed":
          return voice.total_bars === null;
        default:
          return true;
      }
    });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case "clipping-desc":
          return clipBars(b) - clipBars(a);
        case "clipping-asc":
          return clipBars(a) - clipBars(b);
        case "silence-desc":
          return silenceBars(b) - silenceBars(a);
        case "silence-asc":
          return silenceBars(a) - silenceBars(b);
        case "cleanest":
          return clipBars(a) + silenceBars(a) - (clipBars(b) + silenceBars(b));
        case "label":
          return a.label.localeCompare(b.label);
        case "oldest":
          return a.created_at.localeCompare(b.created_at);
        default:
          return b.created_at.localeCompare(a.created_at);
      }
    });
    return sorted;
  }, [voices, qualityFilter, sortBy]);

  /** Builds and downloads a JSON report from each clip's stored .meta.json sidecar. */
  const handleDownloadReport = useCallback(async () => {
    setReportBusy(true);
    try {
      const report = await buildClipAnalysisReport(visibleVoices);
      downloadReport(report);
      const missing = report.summary.clips - report.summary.withSidecar;
      toast.success(
        missing
          ? `Report downloaded (${report.summary.withSidecar} of ${report.summary.clips} sidecars found)`
          : `Report downloaded for ${report.summary.clips} clip${report.summary.clips === 1 ? "" : "s"}`,
      );
    } catch {
      toast.error("Could not build the analysis report. Please try again.");
    } finally {
      setReportBusy(false);
    }
  }, [visibleVoices]);

  const listVoices = useServerFn(listVoiceProfiles);
  const saveVoice = useServerFn(saveVoiceProfile);
  const removeVoice = useServerFn(deleteVoiceProfile);
  const renameVoice = useServerFn(renameVoiceProfile);
  const startClone = useServerFn(startVoiceCloneJob);
  const pollClone = useServerFn(getVoiceCloneJob);

  const refresh = useCallback(async () => {
    try {
      if (!(await hasSupabaseSession())) return;
      setVoices(await listVoices({ data: undefined }));
    } catch {
      /* signed out or offline — panel simply shows nothing */
    }
  }, [listVoices]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => () => {
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
      if (tickRef.current) window.clearInterval(tickRef.current);
      if (sample) URL.revokeObjectURL(sample.url);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** Normalises any clip to exactly TARGET_SECONDS, rejecting bad lengths. */
  async function setSampleFile(file: File) {
    setPreparing(true);
    setProgress(IDLE_PROGRESS);
    try {
      const result = await trimVoiceSample(file, 0);
      if (!result.ok) {
        setSample((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return null;
        });
        setSource((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return null;
        });
        setProgress({
          phase: "error",
          percent: 0,
          message: "That sample can't be used",
          detail: result.message,
        });
        toast.error(result.message);
        return;
      }
      appliedStart.current = 0;
      setTrimStart(0);
      setSource((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { file, url: URL.createObjectURL(file), duration: result.duration };
      });
      setSample((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return {
          file: result.file,
          url: URL.createObjectURL(result.file),
          source: result.duration,
        };
      });
      toast.success(
        result.trimmed
          ? `Loaded ${result.duration.toFixed(1)}s — drag the window to pick your ${TARGET_SECONDS} seconds.`
          : `Captured a ${TARGET_SECONDS}-second sample.`,
      );
    } finally {
      setPreparing(false);
    }
  }

  /** Re-cuts the sample (debounced) whenever the selection window moves. */
  useEffect(() => {
    if (!source) return;
    if (Math.abs(trimStart - appliedStart.current) < 0.02) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setPreparing(true);
      try {
        const result = await trimVoiceSample(source.file, trimStart);
        if (cancelled) return;
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        appliedStart.current = result.start;
        setSample((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return {
            file: result.file,
            url: URL.createObjectURL(result.file),
            source: result.duration,
          };
        });
      } finally {
        if (!cancelled) setPreparing(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimStart, source]);

  /** Grades the trimmed clip for silence / clipping before it can be uploaded. */
  useEffect(() => {
    if (!sample) {
      setQuality(null);
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    setQuality(null);
    void analyseVoiceSample(sample.file)
      .then((result) => {
        if (cancelled) return;
        setQuality(result);
        if (result?.blocked) {
          toast.error(result.issues.find((issue) => issue.level === "block")?.message ?? "");
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sample]);


  function fileFromDrag(dataTransfer: DataTransfer): File | null {
    if (!dataTransfer?.files?.length) return null;
    const file = dataTransfer.files[0];
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    const allowed = [".mp3", ".wav", ".webm", ".m4a"];
    if (!allowed.includes(ext)) {
      toast.error("Only .mp3 or .wav voice clips can be dropped here.");
      return null;
    }
    return file;
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current += 1;
    if (event.dataTransfer.types.includes("Files")) setDragging(true);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.types.includes("Files")) setDragging(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    const file = fileFromDrag(event.dataTransfer);
    if (file) runOrPrompt(() => void setSampleFile(file));
  }

  async function startRecording() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(VOICE_CAPTURE_CONSTRAINTS);
    } catch {
      toast.error("Microphone access is needed to record a voice sample.");
      return;
    }

    const recorder = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      if (tickRef.current) window.clearInterval(tickRef.current);
      setRecording(false);
      setCountdown(RECORD_SECONDS);
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (blob.size < 2048) {
        toast.error("That recording came out empty — try again and speak clearly.");
        return;
      }
      void setSampleFile(
        new File([blob], `voice-sample-${Date.now()}.webm`, { type: blob.type }),
      );
    };

    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
    setCountdown(RECORD_SECONDS);
    tickRef.current = window.setInterval(() => setCountdown((n) => Math.max(0, n - 1)), 1000);
    stopTimerRef.current = window.setTimeout(() => stopRecording(), RECORD_SECONDS * 1000);
  }

  function stopRecording() {
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  async function handleClone() {
    if (!readStoredVocalConsent()) {
      runOrPrompt(() => void handleClone());
      return;
    }
    if (!sample) {
      toast.error("Record a 10-second sample or upload a clip first.");
      return;
    }
    if (checking) {
      toast.error("Still checking the audio quality — one moment.");
      return;
    }
    if (quality?.blocked) {
      toast.error(
        quality.issues.find((issue) => issue.level === "block")?.message ??
          "This sample's quality is too low to clone.",
      );
      return;
    }

    const name = label.trim() || "My voice";
    const totalKb = Math.max(1, Math.round(sample.file.size / 1024));
    setBusy(true);
    setProgress({
      phase: "uploading",
      percent: 2,
      message: "Uploading your voice sample…",
      detail: `${sample.file.name} · 0 / ${totalKb} KB`,
    });
    try {
      const upload = await uploadVoiceSample(
        sample.file,
        (p) => {
        const sentKb = Math.round(p.loaded / 1024);
        // Upload occupies the first 30% of the overall clone progress bar.
        const pct = p.percent === null ? 15 : Math.max(2, Math.round(p.percent * 0.3));
        setProgress({
          phase: "uploading",
          percent: pct,
          message:
            p.percent !== null && p.percent >= 100
              ? "Upload complete — preparing the clone job…"
              : `Uploading your voice sample… ${p.percent ?? 0}%`,
            detail: `${sample.file.name} · ${sentKb} / ${totalKb} KB`,
          });
        },
        {
          trimStartSeconds: appliedStart.current,
          trimEndSeconds: appliedStart.current + TARGET_SECONDS,
          trimDurationSeconds: TARGET_SECONDS,
          sourceDurationSeconds: source?.duration ?? sample.source,
          quality: quality
            ? {
                peak: quality.peak,
                rms: quality.rms,
                clipRatio: quality.clipRatio,
                silenceRatio: quality.silenceRatio,
                blocked: quality.blocked,
                issues: quality.issues.map((issue) => ({
                  level: issue.level,
                  message: issue.message,
                })),
              }
            : null,
        },
      );
      if (!upload.ok) throw new Error(upload.message);


      setProgress({
        phase: "cloning",
        percent: 35,
        message: "Saving your take…",
        detail: "Job starting",
      });
      const job = await startClone({ data: { sampleUrl: upload.url } });
      let current = job;
      for (let i = 0; i < MAX_POLLS && !current.voiceId; i += 1) {
        if (current.status === "failed" || current.status === "canceled") {
          throw new Error(current.error ?? "Voice cloning failed. Try a cleaner sample.");
        }
        setProgress({
          phase: "cloning",
          percent: Math.min(90, 35 + Math.round(((i + 1) / MAX_POLLS) * 55)),
          message: "Saving your take…",
          detail: `Status: ${current.status || "processing"} · check ${i + 1} of ${MAX_POLLS}`,
        });
        await sleep(POLL_MS);
        if (!current.id) break;
        current = await pollClone({ data: { id: current.id } });
      }
      if (!current.voiceId) throw new Error("The voice clone did not finish in time. Try again.");

      setProgress({
        phase: "saving",
        percent: 95,
        message: "Saving your voice to the library…",
      });
      try {
        const saved = await saveVoice({
          data: {
            label: name,
            voiceId: current.voiceId,
            sampleUrl: upload.url,
            quality: quality
              ? {
                  peak: quality.peak,
                  rms: quality.rms,
                  clipRatio: quality.clipRatio,
                  silenceRatio: quality.silenceRatio,
                  clipBars: quality.clipBars,
                  silenceBars: quality.silenceBars,
                  totalBars: quality.totalBars,
                  blocked: quality.blocked,
                  trimStartSeconds: appliedStart.current,
                }
              : null,
          },
        });
        setVoices((prev) => [saved, ...prev]);
        setActiveVoiceId(saved.voice_id);
        notifyActiveVoiceChange();
        setProgress({
          phase: "done",
          percent: 100,
          message: `"${saved.label}" is ready`,
          detail: `Voice ID: ${saved.voice_id}`,
        });
        setLabel("");
        toast.success(`"${saved.label}" is in your Voice Library and selected for your next track.`);
      } catch (libraryError) {
        const postgrest = parseVoiceProfileSaveError(libraryError);
        console.error(
          "[voice_profiles] save failed — sample is in Storage; library row missing",
          postgrest ?? libraryError,
        );
        // Sample URL is already valid in Storage — do not treat as a hard clone failure.
        setActiveVoiceId(current.voiceId);
        notifyActiveVoiceChange();
        setProgress({
          phase: "done",
          percent: 100,
          message: "Uploaded — library sync failed",
          detail:
            postgrest?.message ??
            (libraryError instanceof Error ? libraryError.message : "Could not save voice to library"),
        });
        setLabel("");
        toast.warning(
          "Voice sample is in Storage and ready to use. Library sync failed — see browser console for the PostgREST error.",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice cloning failed.";
      console.error("[voice_profiles] clone/upload failed", error);
      setProgress((prev) => ({
        phase: "error",
        percent: prev.percent,
        message:
          prev.phase === "uploading" ? "Upload failed" : prev.phase === "saving" ? "Could not save the voice" : "Voice cloning failed",
        detail: message,
      }));
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(voice: VoiceProfile) {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete "${voice.label}"? The stored sample is removed too.`)
    ) {
      return;
    }
    setRowBusyId(voice.id);
    try {
      const result = await removeVoice({ data: { id: voice.id } });
      setVoices((prev) => prev.filter((item) => item.id !== voice.id));
      if (activeVoiceId === voice.voice_id) {
        setActiveVoiceId("");
        notifyActiveVoiceChange();
      }
      toast.success(
        result.sampleRemoved
          ? `Removed "${voice.label}" and its stored sample.`
          : `Removed "${voice.label}".`,
      );
    } catch {
      toast.error("Could not remove that voice. Try again.");
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleRename(voice: VoiceProfile) {
    const next = editingLabel.trim();
    if (!next) {
      toast.error("Give the voice a name.");
      return;
    }
    if (next === voice.label) {
      setEditingId(null);
      return;
    }
    setRowBusyId(voice.id);
    try {
      const updated = await renameVoice({ data: { id: voice.id, label: next } });
      setVoices((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEditingId(null);
      toast.success(`Renamed to "${updated.label}".`);
    } catch {
      toast.error("Could not rename that voice. Try again.");
    } finally {
      setRowBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mic className="size-5" aria-hidden /> Voice Library
        </CardTitle>
        <CardDescription>
          Record a clean {RECORD_SECONDS}-second sample (or upload an .mp3 / .wav), clone it, then pick
          your own voice when you generate a track. Clips are trimmed to exactly {TARGET_SECONDS}s;
          anything shorter than that or longer than {MAX_SECONDS}s is rejected.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="voice-label">Voice name</Label>
          <Input
            id="voice-label"
            value={label}
            maxLength={80}
            placeholder="e.g. Lead vocal — Philip"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>

        <div
          ref={dropZoneRef}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`space-y-4 rounded-xl border-2 border-dashed p-4 transition-colors ${
            dragging
              ? "border-primary bg-primary/10"
              : "border-border/60 bg-background/40"
          }`}
          role="region"
          aria-label="Voice sample drop zone"
        >
          <div className="flex flex-wrap items-center gap-3">
            {recording ? (
              <Button type="button" variant="destructive" onClick={stopRecording}>
                <Square className="mr-2 size-4" aria-hidden /> Stop ({countdown}s)
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => runOrPrompt(() => void startRecording())}
                disabled={busy || preparing}
              >
                <Mic className="mr-2 size-4" aria-hidden /> Record {RECORD_SECONDS}s sample
              </Button>
            )}

            <input
              ref={fileRef}
              type="file"
              accept={VOICE_SAMPLE_ACCEPT}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void setSampleFile(file);
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => runOrPrompt(() => fileRef.current?.click())}
              disabled={busy || preparing}
            >
              <Upload className="mr-2 size-4" aria-hidden /> Upload .mp3 / .wav
            </Button>

            <Button
              type="button"
              onClick={handleClone}
              disabled={
                busy ||
                preparing ||
                checking ||
                !sample ||
                !(termsAccepted || readStoredVocalConsent()) ||
                quality?.blocked === true
              }
            >
              {busy ? (
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              ) : (
                <Wand2 className="mr-2 size-4" aria-hidden />
              )}
              Clone My Voice
            </Button>
          </div>

          {recording ? (
            <div className="space-y-2" aria-live="polite">
              <p className="text-sm font-medium">Recording — {countdown}s left</p>
              <Progress
                value={((RECORD_SECONDS - countdown) / RECORD_SECONDS) * 100}
                className="h-2"
              />
              <p className="text-xs text-muted-foreground">
                Stops automatically at {RECORD_SECONDS} seconds.
              </p>
            </div>
          ) : null}

          {preparing ? (
            <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Trimming your sample to{" "}
              {TARGET_SECONDS} seconds…
            </p>
          ) : null}

          {source && source.duration > TARGET_SECONDS + 0.05 ? (
            <div className="space-y-2">
              <WaveformPreview
                key={`trim-${source.url}`}
                file={source.file}
                url={source.url}
                caption={`Choose your ${TARGET_SECONDS} seconds — drag the highlighted window (arrow keys to nudge, Shift for 1s steps).`}
                selection={{
                  start: trimStart,
                  length: TARGET_SECONDS,
                  onChange: setTrimStart,
                }}
              />
              <p className="text-xs text-muted-foreground">
                Selection: {formatClock(trimStart)} → {formatClock(trimStart + TARGET_SECONDS)} of{" "}
                {formatClock(source.duration)}
              </p>
            </div>
          ) : null}

          {sample ? (
            <div className="space-y-3">
              <WaveformPreview
                file={sample.file}
                url={sample.url}
                showThresholds
                caption={`Sample preview — ${sample.file.name} · exactly ${TARGET_SECONDS}s${
                  sample.source > TARGET_SECONDS + 0.05
                    ? ` (from ${formatClock(appliedStart.current)})`
                    : ""
                }`}
              />

              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = sample.url;
                    a.download = sample.file.name || "voice-sample.wav";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    toast.success("Downloading the trimmed sample.");
                  }}
                >
                  Download trimmed clip
                </Button>
              </div>
            </div>
          ) : (


            <p className="text-center text-sm text-muted-foreground">
              Drag and drop an .mp3 or .wav file here, or use the buttons above.
            </p>
          )}

          {sample && checking ? (
            <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Checking audio quality…
            </p>
          ) : null}

          {sample && quality ? (
            <div
              aria-live="polite"
              className={`space-y-2 rounded-xl border p-3 text-sm ${
                quality.blocked
                  ? "border-destructive/50 bg-destructive/10"
                  : quality.issues.length > 0
                    ? "border-amber-500/50 bg-amber-500/10"
                    : "border-border/60 bg-background/40"
              }`}
            >
              <p className="font-medium">
                {quality.blocked
                  ? "Sample quality too low — cloning is blocked"
                  : quality.issues.length > 0
                    ? "Sample usable, but worth re-recording"
                    : "Sample quality looks good"}
              </p>
              {quality.issues.map((issue) => (
                <p key={issue.id} className="text-muted-foreground">
                  {issue.message}
                </p>
              ))}
              <p className="font-mono text-xs text-muted-foreground">
                peak {toDb(quality.peak)} · avg {toDb(quality.rms)} · clipped{" "}
                {(quality.clipRatio * 100).toFixed(2)}% · silence{" "}
                {Math.round(quality.silenceRatio * 100)}%
              </p>
            </div>
          ) : null}

          {sample ? (
            <ClipMetadataPanel
              fileName={sample.file.name}
              fileSizeBytes={sample.file.size}
              trimStart={appliedStart.current}
              trimLength={TARGET_SECONDS}
              sourceDuration={source?.duration ?? sample.source}
              quality={quality}
            />
          ) : null}

        </div>



        {progress.phase !== "idle" ? (
          <div
            aria-live="polite"
            className={`space-y-2 rounded-xl border p-3 ${
              progress.phase === "error"
                ? "border-destructive/50 bg-destructive/10"
                : "border-border/60 bg-background/40"
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              {progress.phase === "error" ? (
                <AlertTriangle className="size-4 text-destructive" aria-hidden />
              ) : progress.phase === "done" ? (
                <CheckCircle2 className="size-4 text-primary" aria-hidden />
              ) : (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              )}
              <span>{progress.message}</span>
            </div>
            <Progress value={progress.percent} className="h-2" />
            {progress.detail ? (
              <p className="text-xs text-muted-foreground">{progress.detail}</p>
            ) : null}
            {progress.phase === "error" ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  onClick={handleClone}
                  disabled={busy || !sample || !(termsAccepted || readStoredVocalConsent())}
                >
                  <RotateCcw className="mr-2 size-4" aria-hidden /> Retry cloning
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setProgress(IDLE_PROGRESS)}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="active-voice">Voice used when generating</Label>
          <Select
            value={activeVoiceId || "none"}
            onValueChange={(value) => {
              setActiveVoiceId(value === "none" ? "" : value);
              notifyActiveVoiceChange();
            }}
          >
            <SelectTrigger id="active-voice">
              <SelectValue placeholder="Default engine vocal" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Default engine vocal</SelectItem>
              {voices.map((voice) => (
                <SelectItem key={voice.id} value={voice.voice_id}>
                  {voice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-semibold">Manage cloned voices</Label>
            <span className="text-xs text-muted-foreground">
              {visibleVoices.length} of {voices.length} saved
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <div className="min-w-40 flex-1">
              <Label htmlFor="voice-filter" className="text-xs text-muted-foreground">
                Filter
              </Label>
              <Select value={qualityFilter} onValueChange={setQualityFilter}>
                <SelectTrigger id="voice-filter" className="mt-1">
                  <SelectValue placeholder="All clips" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All clips</SelectItem>
                  <SelectItem value="violations">Any violation</SelectItem>
                  <SelectItem value="clipping">Clipping bars &gt; 0</SelectItem>
                  <SelectItem value="silence">Silence bars &gt; 0</SelectItem>
                  <SelectItem value="clean">Clean (no violations)</SelectItem>
                  <SelectItem value="flagged">Flagged low quality</SelectItem>
                  <SelectItem value="unanalysed">No analysis stored</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-40 flex-1">
              <Label htmlFor="voice-sort" className="text-xs text-muted-foreground">
                Sort
              </Label>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger id="voice-sort" className="mt-1">
                  <SelectValue placeholder="Newest first" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="oldest">Oldest first</SelectItem>
                  <SelectItem value="label">Name (A–Z)</SelectItem>
                  <SelectItem value="clipping-desc">Most clipping bars</SelectItem>
                  <SelectItem value="clipping-asc">Fewest clipping bars</SelectItem>
                  <SelectItem value="silence-desc">Most silence bars</SelectItem>
                  <SelectItem value="silence-asc">Fewest silence bars</SelectItem>
                  <SelectItem value="cleanest">Cleanest overall</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
            <p className="text-xs text-muted-foreground">
              Export a JSON analysis report built from each clip&apos;s stored{" "}
              <code>.meta.json</code> sidecar.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!visibleVoices.length || reportBusy}
              onClick={handleDownloadReport}
            >
              {reportBusy ? "Building…" : "Download analysis report"}
            </Button>
          </div>

          {visibleVoices.length ? (
            <ul className="space-y-2">
              {visibleVoices.map((voice) => {
                const editing = editingId === voice.id;
                const rowBusy = rowBusyId === voice.id;
                return (
                  <li
                    key={voice.id}
                    className="space-y-2 rounded-md border border-border/60 px-3 py-2"
                  >
                    {editing ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          value={editingLabel}
                          maxLength={80}
                          autoFocus
                          aria-label={`Rename ${voice.label}`}
                          className="h-9 min-w-40 flex-1"
                          onChange={(event) => setEditingLabel(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void handleRename(voice);
                            if (event.key === "Escape") setEditingId(null);
                          }}
                        />
                        <Button
                          type="button"
                          size="sm"
                          disabled={rowBusy}
                          onClick={() => void handleRename(voice)}
                        >
                          <Check className="mr-1.5 size-4" aria-hidden /> Save
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {voice.label}
                            {activeVoiceId === voice.voice_id ? (
                              <span className="ml-2 rounded-full border border-primary/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                                In use
                              </span>
                            ) : null}
                          </p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {voice.voice_id}
                          </p>
                          <p className="font-mono text-[11px] text-muted-foreground">
                            {voice.total_bars === null
                              ? "no analysis stored"
                              : `${voice.clip_bars ?? 0} clipping · ${voice.silence_bars ?? 0} silent of ${voice.total_bars} bars`}
                            {voice.quality_blocked ? " · flagged" : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Copy voice ID for ${voice.label}`}
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(voice.voice_id)
                                .then(() => toast.success("Voice ID copied."))
                                .catch(() => toast.error("Copy failed."));
                            }}
                          >
                            <Copy className="size-4" aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Rename ${voice.label}`}
                            onClick={() => {
                              setEditingId(voice.id);
                              setEditingLabel(voice.label);
                            }}
                          >
                            <Pencil className="size-4" aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-expanded={diffId === voice.id}
                            aria-label={`Compare stored metadata for ${voice.label}`}
                            onClick={() => setDiffId((id) => (id === voice.id ? null : voice.id))}
                          >
                            <GitCompare className="size-4" aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={rowBusy}
                            aria-label={`Delete ${voice.label}`}
                            onClick={() => void handleDelete(voice)}
                          >
                            {rowBusy ? (
                              <Loader2 className="size-4 animate-spin" aria-hidden />
                            ) : (
                              <Trash2 className="size-4 text-destructive" aria-hidden />
                            )}
                          </Button>
                        </div>
                      </div>
                    )}

                    {diffId === voice.id ? <ClipMetadataDiff voice={voice} /> : null}
                  </li>

                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {voices.length
                ? "No clips match this filter."
                : "No cloned voices saved yet."}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Deleting a voice also removes its stored sample from your library storage.
          </p>
        </div>

      </CardContent>
      <VocalLiabilityModal
        open={modalOpen}
        onOpenChange={handleOpenChange}
        onAccepted={handleAccepted}
      />
    </Card>
  );
}
