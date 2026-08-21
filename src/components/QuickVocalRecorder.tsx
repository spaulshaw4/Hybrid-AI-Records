import { useCallback, useEffect, useRef, useState } from "react";
import { hasSupabaseSession } from "@/lib/has-session";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Mic, Square, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  trimVoiceSample,
} from "@/lib/voice-sample-trim";
import {
  VOICE_SAMPLE_ACCEPT,
  VOICE_SAMPLE_MAX_BYTES,
  uploadVoiceSample,
} from "@/lib/voice-sample-upload";

import {
  getVoiceCloneJob,
  listVoiceProfiles,
  saveVoiceProfile,
  startVoiceCloneJob,
  type VoiceProfile,
} from "@/lib/voice-library.functions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VocalLiabilityModal } from "@/components/VocalLiabilityModal";
import { useVocalLiability } from "@/hooks/use-vocal-liability";
import { CUSTOM_AUDIO_FILE_INPUT_ID, type VocalMode } from "@/lib/studio-payload";

const MAX_SECONDS = 15;
const POLL_MS = 4000;
const MAX_POLLS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Props = {
  /** Cloned voice currently applied to the generation, or "" for the AI voice. */
  voiceId: string;
  vocalMode?: VocalMode;
  onVoiceIdChange: (voiceId: string) => void;
  /** Fired after the session liability modal is accepted. */
  onTermsAcceptedChange?: (accepted: boolean) => void;
  /** Fired when the user starts a record or upload attempt. */
  onCustomVocalIntent?: () => void;
  /** Current recorded/uploaded take, or null when discarded. */
  onCustomFileChange?: (file: File | Blob | null) => void;
};

/**
 * One-tap vocal capture: record up to 15 seconds, listen back, then turn the
 * take into a custom voice the studio sings with. No wizards, no tabs.
 */
export function QuickVocalRecorder({
  voiceId,
  onVoiceIdChange,
  onTermsAcceptedChange,
  onCustomVocalIntent,
  onCustomFileChange,
}: Props) {
  const { modalOpen, runOrPrompt, handleAccepted, handleOpenChange } =
    useVocalLiability(onTermsAcceptedChange);
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<{ blob: Blob; url: string; fileName?: string } | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [clipDuration, setClipDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimLength, setTrimLength] = useState(10);
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [clipped, setClipped] = useState(false);
  const [busy, setBusy] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const meterFillRef = useRef<HTMLDivElement | null>(null);
  const meterRootRef = useRef<HTMLDivElement | null>(null);
  const stopAtRef = useRef<number | null>(null);


  const effectiveLength = Math.min(
    MAX_CLIP_SECONDS,
    Math.max(MIN_CLIP_SECONDS, Math.min(trimLength, clipDuration || trimLength)),
  );
  const maxStart = Math.max(0, (clipDuration || 0) - effectiveLength);

  const listVoices = useServerFn(listVoiceProfiles);
  const startClone = useServerFn(startVoiceCloneJob);
  const pollClone = useServerFn(getVoiceCloneJob);
  const saveVoice = useServerFn(saveVoiceProfile);

  const loadVoices = useCallback(async () => {
    try {
      if (!(await hasSupabaseSession())) {
        setVoices([]);
        return;
      }
      setVoices(await listVoices({ data: undefined }));
    } catch {
      setVoices([]);
    }
  }, [listVoices]);

  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  useEffect(() => {
    onCustomFileChange?.(clip ? clip.blob : null);
  }, [clip, onCustomFileChange]);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      stopMeter();
      if (clip) URL.revokeObjectURL(clip.url);
    };
    // Cleanup only on unmount; clip URLs are revoked when replaced too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Live input meter: RMS level + peak/clip detection while recording. */
  function startMeter(stream: MediaStream) {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const context = new AudioCtx();
    meterCtxRef.current = context;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    let lastReact = 0;
    let peakHold = 0;

    const paint = (nextLevel: number, didClip: boolean) => {
      const fill = meterFillRef.current;
      if (fill) {
        fill.style.width = `${Math.round(nextLevel * 100)}%`;
        fill.classList.toggle("bg-destructive", didClip || nextLevel > 0.95);
        fill.classList.toggle("bg-amber-500", !didClip && nextLevel > 0.75 && nextLevel <= 0.95);
        fill.classList.toggle("bg-primary", !didClip && nextLevel <= 0.75);
      }
      const root = meterRootRef.current;
      if (root) root.setAttribute("aria-valuenow", String(Math.round(nextLevel * 100)));
    };

    const tick = () => {
      if (document.visibilityState === "hidden") {
        meterRafRef.current = window.requestAnimationFrame(tick);
        return;
      }
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      let framePeak = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const sample = buffer[i] ?? 0;
        sum += sample * sample;
        const abs = Math.abs(sample);
        if (abs > framePeak) framePeak = abs;
      }
      const rms = Math.sqrt(sum / buffer.length);
      const nextLevel = Math.min(1, rms * 3);
      if (framePeak > peakHold) peakHold = framePeak;
      const didClip = framePeak >= 0.98;
      paint(nextLevel, didClip);

      const now = performance.now();
      if (now - lastReact >= 100) {
        lastReact = now;
        setLevel(nextLevel);
        setPeak(peakHold);
        if (didClip) setClipped(true);
      }
      meterRafRef.current = window.requestAnimationFrame(tick);
    };
    meterRafRef.current = window.requestAnimationFrame(tick);
  }

  function stopMeter() {
    if (meterRafRef.current) window.cancelAnimationFrame(meterRafRef.current);
    meterRafRef.current = null;
    void meterCtxRef.current?.close();
    meterCtxRef.current = null;
    setLevel(0);
  }

  function stopTimer() {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }

  function handleCustomVocalAttempt(actionType: "record" | "upload") {
    onCustomVocalIntent?.();
    runOrPrompt(() => {
      if (actionType === "record") void startRecording();
      else fileInputRef.current?.click();
    });
  }

  async function startRecording() {
    if (recording) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      toast.error("Microphone access is needed to record your vocals.");
      return;
    }

    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      stopMeter();
      stopTimer();
      setRecording(false);
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      if (blob.size < 2048) {
        toast.error("That take was empty — try again a little closer to the mic.");
        return;
      }
      resetTrim();
      setClip((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { blob, url: URL.createObjectURL(blob) };
      });
    };

    setSeconds(0);
    setPeak(0);
    setClipped(false);
    setRecording(true);
    startMeter(stream);
    recorder.start();
    timerRef.current = window.setInterval(() => {
      setSeconds((prev) => {
        const next = prev + 1;
        if (next >= MAX_SECONDS) recorder.stop();
        return next;
      });
    }, 1000);
  }

  function stopRecording() {
    recorderRef.current?.stop();
  }

  function resetTrim() {
    setClipDuration(0);
    setTrimStart(0);
    setTrimLength(10);
    stopAtRef.current = null;
  }

  /** Plays only the selected window so you can audition the trim. */
  function previewSelection() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = trimStart;
    stopAtRef.current = trimStart + effectiveLength;
    void audio.play();
  }

  function discard() {
    resetTrim();
    setClip((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setSeconds(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /** Accepts a pre-recorded WAV/MP3 take instead of recording live. */
  function pickFile(file: File | undefined) {
    if (!file) return;
    if (file.size > VOICE_SAMPLE_MAX_BYTES) {
      toast.error("That file is too large — keep vocal clips under 25 MB.");
      return;
    }
    const ok = /\.(mp3|wav|webm|m4a)$/i.test(file.name) || file.type.startsWith("audio/");
    if (!ok) {
      toast.error("Upload a WAV or MP3 audio file.");
      return;
    }
    setClip((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { blob: file, url: URL.createObjectURL(file), fileName: file.name };
    });
    resetTrim();
    setSeconds(0);
  }

  async function useMyVoice() {
    if (!clip || busy) return;
    setBusy(true);
    try {
      setStatus("Uploading your take…");
      const file = new File([clip.blob], clip.fileName ?? `vocal-take-${Date.now()}.webm`, {
        type: clip.blob.type || "audio/webm",
      });
      const trimmed = await trimVoiceSample(file, trimStart, effectiveLength);
      if (!trimmed.ok) throw new Error(trimmed.message);
      const upload = await uploadVoiceSample(trimmed.file);
      if (!upload.ok) throw new Error(upload.message);


      setStatus("Saving your take…");
      let job = await startClone({ data: { sampleUrl: upload.url } });
      for (let i = 0; i < MAX_POLLS && !job.voiceId; i += 1) {
        if (job.status === "failed" || job.status === "canceled") {
          throw new Error(job.error ?? "That take could not be cloned. Try a cleaner one.");
        }
        await sleep(POLL_MS);
        if (!job.id) break;
        job = await pollClone({ data: { id: job.id } });
      }
      if (!job.voiceId) throw new Error("Your voice took too long to build. Try again.");

      setStatus("Saving your voice…");
      const saved = await saveVoice({
        data: {
          label: name.trim() || `My voice ${new Date().toLocaleDateString()}`,
          voiceId: job.voiceId,
          sampleUrl: upload.url,
        },
      });
      onVoiceIdChange(saved.voice_id);
      setName("");
      discard();
      await loadVoices();
      toast.success("Custom vocals ready — your next track sings in your voice.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not use that take.");
    } finally {
      setStatus(null);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {voices.length > 0 ? (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Saved voice</Label>
          <Select
            value={voiceId || undefined}
            onValueChange={(next) => {
              onCustomVocalIntent?.();
              runOrPrompt(() => onVoiceIdChange(next));
            }}
          >
            <SelectTrigger aria-label="Saved custom voice">
              <SelectValue placeholder="Choose a saved voice" />
            </SelectTrigger>
            <SelectContent>
              {voices.map((voice) => (
                <SelectItem key={voice.id} value={voice.voice_id}>
                  {voice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {recording ? (
          <button
            type="button"
            aria-label="Stop recording"
            onClick={stopRecording}
            className="group flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-destructive bg-destructive/10 px-4 py-5 text-center transition-colors hover:bg-destructive/20"
          >
            <Square className="size-5 text-destructive" aria-hidden />
            <span className="text-sm font-semibold text-destructive">Stop recording</span>
            <span className="text-xs font-mono text-destructive">
              {seconds}s / {MAX_SECONDS}s
            </span>
          </button>
        ) : (
          <button
            type="button"
            id="record-vocals-btn"
            aria-label={clip ? "Record again" : "Record Vocals"}
            onClick={() => handleCustomVocalAttempt("record")}
            disabled={busy}
            className="group flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-primary bg-muted/30 px-4 py-5 text-center transition-colors hover:border-primary hover:bg-primary/10 disabled:opacity-50"
          >
            <Mic className="size-5 text-primary transition-colors" aria-hidden />
            <span className="text-sm font-semibold">{clip ? "Record again" : "Record Vocals"}</span>
          </button>
        )}

        <button
          type="button"
          id="upload-mp3-btn"
          aria-label="Upload MP3"
          disabled={busy || recording}
          onClick={() => handleCustomVocalAttempt("upload")}
          className="group flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-primary bg-muted/30 px-4 py-5 text-center transition-colors hover:border-primary hover:bg-primary/10 disabled:opacity-50"
        >
          <Upload className="size-5 text-primary" aria-hidden />
          <span className="text-sm font-semibold">Upload MP3</span>
        </button>
      </div>

      <input
        ref={fileInputRef}
        id={CUSTOM_AUDIO_FILE_INPUT_ID}
        type="file"
        accept={VOICE_SAMPLE_ACCEPT}
        className="sr-only"
        aria-label="Upload a vocal file (WAV or MP3)"
        onChange={(e) => pickFile(e.target.files?.[0])}
      />

      <p className="text-center text-xs text-muted-foreground">
        Record or upload a take, then tap Use my voice — or pick a saved voice above.
      </p>

      {clip ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full text-muted-foreground hover:text-foreground"
          onClick={discard}
          disabled={busy}
        >
          <Trash2 className="mr-2 size-4" aria-hidden /> Discard take
        </Button>
      ) : null}

      {recording || peak > 0 ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Input level</span>
            <span className="font-mono">
              peak {peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dB` : "—"}
            </span>
          </div>
          <div
            ref={meterRootRef}
            className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
            role="meter"
            aria-label="Recording input level"
            aria-valuenow={Math.round(level * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              ref={meterFillRef}
              className={`h-full transition-[width] duration-75 ${
                clipped || level > 0.95
                  ? "bg-destructive"
                  : level > 0.75
                    ? "bg-amber-500"
                    : "bg-primary"
              }`}
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
          {clipped ? (
            <p className="text-xs font-medium text-destructive">
              Clipping detected — back off the mic or lower your input gain, then record again for a
              clean, undistorted take.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Aim for the bar to sit in the middle. Red means distortion.
            </p>
          )}
        </div>
      ) : null}

      {clip?.fileName ? (
        <p className="truncate text-xs text-muted-foreground">Selected: {clip.fileName}</p>
      ) : null}

      {clip ? (
        <div className="space-y-2">
          <audio
            ref={audioRef}
            src={clip.url}
            controls
            className="w-full"
            onLoadedMetadata={(e) => {
              const total = e.currentTarget.duration;
              if (Number.isFinite(total) && total > 0) {
                setClipDuration(total);
                setTrimStart(0);
                setTrimLength(Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, total)));
              }
            }}
            onTimeUpdate={(e) => {
              const stopAt = stopAtRef.current;
              if (stopAt !== null && e.currentTarget.currentTime >= stopAt) {
                e.currentTarget.pause();
                stopAtRef.current = null;
              }
            }}
          />

          {clipDuration > 0 ? (
            <div className="space-y-3 rounded-md border border-border/70 bg-background/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label className="text-xs font-semibold">Trim to your best take</Label>
                <span className="font-mono text-xs text-primary">
                  {trimStart.toFixed(1)}s → {(trimStart + effectiveLength).toFixed(1)}s (
                  {effectiveLength.toFixed(1)}s)
                </span>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Start</Label>
                <Slider
                  value={[Math.min(trimStart, maxStart)]}
                  min={0}
                  max={Math.max(0.1, maxStart)}
                  step={0.1}
                  aria-label="Trim start"
                  onValueChange={([v]) => setTrimStart(Math.min(v ?? 0, maxStart))}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Length (5–15s)</Label>
                <Slider
                  value={[effectiveLength]}
                  min={MIN_CLIP_SECONDS}
                  max={Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, clipDuration))}
                  step={0.5}
                  aria-label="Trim length"
                  onValueChange={([v]) => setTrimLength(v ?? trimLength)}
                />
              </div>

              <Button type="button" variant="outline" size="sm" onClick={previewSelection}>
                Preview selection
              </Button>
            </div>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={name}
              maxLength={80}
              placeholder="Name this voice (optional)"
              onChange={(e) => setName(e.target.value)}
              aria-label="Voice name"
            />
            <Button type="button" onClick={() => void useMyVoice()} disabled={busy}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Use my voice
            </Button>
          </div>
        </div>
      ) : null}

      {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}

      <VocalLiabilityModal
        open={modalOpen}
        onOpenChange={handleOpenChange}
        onAccepted={handleAccepted}
      />
    </div>
  );
}
