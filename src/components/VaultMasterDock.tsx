import { Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  pauseCatalogPlayback,
  playCatalogTrack,
  seekCatalogPlayback,
  useCatalogPlayback,
} from "@/lib/catalog-player";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Single stereo master transport for the Audio Vault. */
export function VaultMasterDock() {
  const playback = useCatalogPlayback();
  const track = playback.currentTrack;
  if (playback.owner !== "vault" || !track) return null;

  const duration = playback.duration || 0;
  const current = playback.currentTime || 0;

  return (
    <div
      id="vault-master-dock"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-zinc-950/95 px-4 py-3 backdrop-blur-xl"
    >
      <div className="mx-auto flex max-w-5xl items-center gap-3">
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="size-10 shrink-0"
          aria-label={playback.playing ? `Pause ${track.title}` : `Play ${track.title}`}
          onClick={() => {
            if (playback.playing) {
              pauseCatalogPlayback();
              return;
            }
            void playCatalogTrack(track, "vault");
          }}
        >
          {playback.playing ? (
            <Pause className="size-4" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
        </Button>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-sm font-semibold text-zinc-100">{track.title}</p>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-500">
              {formatTime(current)} / {formatTime(duration)}
            </span>
          </div>
          <Slider
            min={0}
            max={Math.max(duration, 0.001)}
            step={0.05}
            value={[current]}
            disabled={!(duration > 0)}
            onValueChange={(next) => seekCatalogPlayback(next[0] ?? 0)}
            aria-label="Master transport"
          />
        </div>
      </div>
    </div>
  );
}
