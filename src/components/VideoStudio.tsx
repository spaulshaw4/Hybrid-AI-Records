import type { ChangeEvent } from "react";
import {
  VIDEO_STYLE_PRESETS,
  ARTIST_PERSONAS,
  videoStudioGate,
  type ProductionMode,
  type VideoStyleId,
} from "@/lib/video-studio";

type VideoStudioProps = {
  audioName: string | null;
  vocalName: string | null;
  mode: ProductionMode;
  personaId: string | null;
  styleId: VideoStyleId | null;
  customText: string;
  lyrics: string;
  characterImageName: string | null;
  busy: boolean;
  status: string | null;
  exportUrl: string | null;
  exportName: string;
  onMasterFile: (file: File | null) => void;
  onVocalFile: (file: File | null) => void;
  onMode: (mode: ProductionMode) => void;
  onPersona: (id: string) => void;
  onStyle: (id: VideoStyleId) => void;
  onCustomText: (value: string) => void;
  onLyrics: (value: string) => void;
  onCharacterImage: (file: File | null) => void;
  onGenerate: () => void;
};

function fileFrom(event: ChangeEvent<HTMLInputElement>): File | null {
  return event.target.files?.[0] ?? null;
}

export function VideoStudio({
  audioName,
  vocalName,
  mode,
  personaId,
  styleId,
  customText,
  lyrics,
  characterImageName,
  busy,
  status,
  exportUrl,
  exportName,
  onMasterFile,
  onVocalFile,
  onMode,
  onPersona,
  onStyle,
  onCustomText,
  onLyrics,
  onCharacterImage,
  onGenerate,
}: VideoStudioProps) {
  const gate = videoStudioGate({
    hasAudio: Boolean(audioName),
    mode,
    personaId,
    hasCharacterImage: Boolean(characterImageName),
    styleId,
    customText,
  });

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10 text-zinc-100">
      <h1 className="text-xl font-semibold tracking-[0.12em] text-zinc-50">
        HYBRID AI RECORDS: VIDEO STUDIO
      </h1>
      <p className="mt-3 text-sm text-zinc-400">
        Drop a track. Choose how the video is made. Generate one film.
      </p>

      <section className="mt-8 rounded-xl border border-white/10 bg-zinc-950/50 p-4">
        <h2 className="text-sm font-medium text-zinc-100">1. Drop your audio track</h2>
        <div className="mt-4 space-y-3">
          <label className="block text-sm text-zinc-300">
            Upload master MP3/WAV
            <input
              className="mt-2 block w-full text-sm text-zinc-200 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-zinc-100"
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav"
              aria-label="Upload master MP3/WAV"
              disabled={busy}
              onChange={(event) => onMasterFile(fileFrom(event))}
            />
          </label>
          {audioName ? <p className="text-xs text-zinc-400">{audioName}</p> : null}
          <label className="block text-sm text-zinc-300">
            Optional isolated vocal stem for lip-sync
            <input
              className="mt-2 block w-full text-sm text-zinc-200 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-zinc-100"
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav"
              aria-label="Optional vocal stem"
              disabled={busy}
              onChange={(event) => onVocalFile(fileFrom(event))}
            />
          </label>
          {vocalName ? <p className="text-xs text-zinc-400">{vocalName}</p> : null}
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-white/10 bg-zinc-950/50 p-4">
        <h2 className="text-sm font-medium text-zinc-100">2. Choose production mode</h2>
        <div className="mt-4 grid gap-2" role="radiogroup" aria-label="Production mode">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "auto"}
            disabled={busy}
            onClick={() => onMode("auto")}
            className={`rounded-lg border px-3 py-3 text-left ${
              mode === "auto" ? "border-rose-500 bg-rose-500/10" : "border-white/10 bg-black/20"
            }`}
          >
            <span className="block text-sm font-medium">Auto</span>
            <span className="mt-1 block text-xs text-zinc-400">
              Hands-off. The engine maps beats, style, and pacing.
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "character"}
            disabled={busy}
            onClick={() => onMode("character")}
            className={`rounded-lg border px-3 py-3 text-left ${
              mode === "character"
                ? "border-rose-500 bg-rose-500/10"
                : "border-white/10 bg-black/20"
            }`}
          >
            <span className="block text-sm font-medium">Character</span>
            <span className="mt-1 block text-xs text-zinc-400">
              Pick an artist profile that locks face and wardrobe.
            </span>
          </button>
        </div>

        {mode === "character" ? (
          <div className="mt-4 space-y-3">
            <div className="grid gap-2" role="radiogroup" aria-label="Artist profile">
              {ARTIST_PERSONAS.map((persona) => (
                <button
                  key={persona.id}
                  type="button"
                  role="radio"
                  aria-checked={personaId === persona.id}
                  disabled={busy}
                  onClick={() => onPersona(persona.id)}
                  className={`rounded-lg border px-3 py-2 text-left ${
                    personaId === persona.id ? "border-rose-500" : "border-white/10"
                  }`}
                >
                  <span className="block text-sm">{persona.name}</span>
                  <span className="block text-xs text-zinc-400">{persona.look}</span>
                </button>
              ))}
            </div>
            <label className="block text-sm text-zinc-300">
              Character image
              <input
                className="mt-2 block w-full text-sm text-zinc-200 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-zinc-100"
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                aria-label="Character image"
                disabled={busy}
                onChange={(event) => onCharacterImage(fileFrom(event))}
              />
            </label>
            {characterImageName ? (
              <p className="text-xs text-zinc-400">{characterImageName}</p>
            ) : null}
            <p className="text-xs text-zinc-500">PNG or JPG. Auto mode does not use this.</p>
          </div>
        ) : null}
      </section>

      <section className="mt-4 rounded-xl border border-white/10 bg-zinc-950/50 p-4">
        <h2 className="text-sm font-medium text-zinc-100">3. Select genre / visual style</h2>
        <div className="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Visual style">
          {VIDEO_STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={styleId === preset.id}
              disabled={busy}
              onClick={() => onStyle(preset.id)}
              className={`rounded-full border px-3 py-1.5 text-sm ${
                styleId === preset.id
                  ? "border-rose-500 bg-rose-500/15 text-zinc-50"
                  : "border-white/15 text-zinc-300"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {styleId === "custom" ? (
          <label className="mt-4 block text-sm text-zinc-300">
            Custom style
            <textarea
              className="mt-2 min-h-24 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100"
              aria-label="Custom visual style"
              maxLength={400}
              value={customText}
              disabled={busy}
              onChange={(event) => onCustomText(event.target.value)}
            />
          </label>
        ) : null}
        <label className="mt-4 block text-sm text-zinc-300">
          Song lyrics
          <textarea
            className="mt-2 min-h-28 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100"
            aria-label="Song lyrics"
            maxLength={8000}
            value={lyrics}
            disabled={busy}
            onChange={(event) => onLyrics(event.target.value)}
          />
        </label>
      </section>

      <button
        type="button"
        className="mt-6 w-full rounded-lg bg-rose-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
        disabled={busy || !gate.ok}
        onClick={onGenerate}
      >
        {busy ? "Generating your music video…" : "Generate Music Video"}
      </button>
      {!busy && !gate.ok ? (
        <p className="mt-2 text-center text-xs text-zinc-500">{gate.reason}</p>
      ) : null}
      {status ? <p className="mt-3 text-center text-sm text-zinc-300">{status}</p> : null}

      {exportUrl ? (
        <section className="mt-6 space-y-3">
          <video className="w-full rounded-lg bg-black" src={exportUrl} controls playsInline />
          <a
            className="text-sm font-medium text-rose-300 underline"
            href={exportUrl}
            download={exportName}
          >
            Download music video
          </a>
        </section>
      ) : null}
    </main>
  );
}
