import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Download, Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Props = {
  /** Object URL / CDN URL of the finished master. */
  src: string;
  /** Download filename extension, usually "mp4". */
  extension?: string;
  fileName?: string;
};

/**
 * Playback surface for the completed render: play/pause, scrubber, volume,
 * fullscreen and a one-click MP4 download. No network calls, no retries.
 */
function MasterVideoPlayerBase({ src, extension = "mp4", fileName = "hybrid-cinematic-master" }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.volume = muted ? 0 : volume;
  }, [volume, muted]);

  const toggle = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);

  const seek = useCallback((next: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = next;
    setTime(next);
  }, []);

  const fullscreen = useCallback(() => {
    const node = wrapRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void node.requestFullscreen?.().catch(() => undefined);
  }, []);

  return (
    <div ref={wrapRef} className="space-y-2 rounded-lg bg-black/60 p-2">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="auto"
        className="w-full rounded-md bg-black"
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          const next = Math.floor(e.currentTarget.currentTime);
          setTime((prev) => (Math.floor(prev) === next ? prev : next));
        }}
      />

      <div className="flex flex-wrap items-center gap-3 px-1">
        <Button type="button" size="icon" variant="secondary" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
        </Button>

        <span className="text-[11px] tabular-nums text-muted-foreground">{clock(time)}</span>
        <Slider
          value={[Math.min(time, duration || 0)]}
          max={Math.max(1, Math.floor(duration))}
          step={1}
          onValueChange={([v]) => seek(v ?? 0)}
          aria-label="Timeline scrubber"
          className="min-w-[140px] flex-1"
        />
        <span className="text-[11px] tabular-nums text-muted-foreground">{clock(duration)}</span>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted || volume === 0 ? (
              <VolumeX className="size-4" aria-hidden />
            ) : (
              <Volume2 className="size-4" aria-hidden />
            )}
          </Button>
          <Slider
            value={[muted ? 0 : Math.round(volume * 100)]}
            max={100}
            step={1}
            onValueChange={([v]) => {
              setMuted(false);
              setVolume((v ?? 0) / 100);
            }}
            aria-label="Volume"
            className="w-20"
          />
        </div>

        <Button type="button" size="icon" variant="ghost" onClick={fullscreen} aria-label="Fullscreen">
          <Maximize className="size-4" aria-hidden />
        </Button>

        <Button asChild type="button" size="sm">
          <a href={src} download={`${fileName}.${extension}`}>
            <Download className="size-4" aria-hidden /> Download MP4
          </a>
        </Button>
      </div>
    </div>
  );
}

export const MasterVideoPlayer = memo(MasterVideoPlayerBase);
export default MasterVideoPlayer;
