import { useState, type ChangeEvent, type DragEvent } from "react";
import {
  formatSlotTime,
  videoStudioGate,
  type ScriptMode,
  type ScriptSlot,
} from "@/lib/video-studio";

type VideoStudioProps = {
  audioName: string | null;
  characterPreview: string | null;
  vision: string;
  scriptMode: ScriptMode;
  slots: ScriptSlot[];
  shotNotes: string[];
  busy: boolean;
  status: string | null;
  exportUrl: string | null;
  exportName: string;
  onMasterFile: (file: File | null) => void;
  onCharacterImage: (file: File | null) => void;
  onVision: (value: string) => void;
  onScriptMode: (mode: ScriptMode) => void;
  onShotNote: (index: number, value: string) => void;
  onGenerate: () => void;
};

function fileFrom(event: ChangeEvent<HTMLInputElement>): File | null {
  return event.target.files?.[0] ?? null;
}

function DropCard({
  title,
  hint,
  accept,
  fileName,
  preview,
  onFile,
}: {
  title: string;
  hint: string;
  accept: string;
  fileName: string | null;
  preview?: string | null;
  onFile: (file: File | null) => void;
}) {
  const [over, setOver] = useState(false);

  const take = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setOver(false);
    onFile(event.dataTransfer.files?.[0] ?? null);
  };

  return (
    <section className="flex min-h-[280px] flex-col rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
      <h2 className="text-xs font-semibold tracking-[0.18em] text-zinc-300">{title}</h2>
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={take}
        className={`mt-4 flex flex-1 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-8 text-center transition ${
          over ? "border-rose-300/70 bg-rose-400/10" : "border-white/15 bg-black/30"
        }`}
      >
        {preview ? (
          <img
            src={preview}
            alt="Character preview"
            className="max-h-64 w-full rounded-lg object-contain"
          />
        ) : (
          <span className="text-base text-zinc-200">{fileName ?? hint}</span>
        )}
        <input
          type="file"
          accept={accept}
          aria-label={hint}
          className="sr-only"
          onChange={(event) => onFile(fileFrom(event))}
        />
      </label>
    </section>
  );
}

export function VideoStudio({
  audioName,
  characterPreview,
  vision,
  scriptMode,
  slots,
  shotNotes,
  busy,
  status,
  exportUrl,
  exportName,
  onMasterFile,
  onCharacterImage,
  onVision,
  onScriptMode,
  onShotNote,
  onGenerate,
}: VideoStudioProps) {
  const gate = videoStudioGate({
    hasAudio: Boolean(audioName),
    mode: scriptMode,
    vision,
    shots: shotNotes,
  });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col px-6 py-8 text-zinc-100">
      <h1 className="text-sm font-semibold tracking-[0.22em] text-zinc-50">
        HYBRID AI RECORDS <span className="text-zinc-500">│</span> VIDEO ENGINE
      </h1>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <DropCard
          title="1. The Track"
          hint="🎵 Drop your audio file here"
          accept="audio/mpeg,audio/wav,.mp3,.wav"
          fileName={audioName}
          onFile={onMasterFile}
        />
        <DropCard
          title="2. The Star (Character)"
          hint="👤 Drop character photo here"
          accept="image/png,image/jpeg,.png,.jpg,.jpeg"
          fileName={characterPreview ? null : null}
          preview={characterPreview}
          onFile={onCharacterImage}
        />
      </div>

      <section className="mt-5 rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
        <h2 className="text-xs font-semibold tracking-[0.18em] text-zinc-300">3. The Script</h2>
        <fieldset className="mt-4">
          <legend className="text-sm text-zinc-400">Script mode</legend>
          <div className="mt-3 flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm text-zinc-100">
              <input
                type="radio"
                name="script-mode"
                checked={scriptMode === "auto"}
                onChange={() => onScriptMode("auto")}
              />
              Auto-Direct (Claude)
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-100">
              <input
                type="radio"
                name="script-mode"
                checked={scriptMode === "manual"}
                onChange={() => onScriptMode("manual")}
              />
              Manual Scene-by-Scene
            </label>
          </div>
        </fieldset>

        {scriptMode === "auto" ? (
          <div className="mt-5">
            <label className="block text-sm text-zinc-200" htmlFor="video-concept">
              Describe your video concept
            </label>
            <input
              id="video-concept"
              value={vision}
              onChange={(event) => onVision(event.target.value)}
              placeholder="Moody neon city night drive, heavy rain, dramatic performance"
              className="mt-3 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-base text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            <p className="mt-3 text-sm text-zinc-400">
              Claude listens to the track and breaks down every shot automatically.
            </p>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {slots.length === 0 ? (
              <p className="text-sm text-zinc-400">
                Drop a track and each section of the song shows up here.
              </p>
            ) : (
              slots.map((slot, index) => (
                <label key={`${slot.label}-${slot.start}`} className="block">
                  <span className="text-sm text-zinc-400">
                    Scene {index + 1} · {formatSlotTime(slot.start)}–{formatSlotTime(slot.end)} ·{" "}
                    {slot.label}
                  </span>
                  <input
                    value={shotNotes[index] ?? ""}
                    aria-label={`Scene ${index + 1} ${slot.label}`}
                    onChange={(event) => onShotNote(index, event.target.value)}
                    placeholder="What this section looks like"
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-base text-zinc-100 outline-none placeholder:text-zinc-500"
                  />
                </label>
              ))
            )}
            <p className="text-sm text-zinc-400">
              You dictate exactly what happens in each section.
            </p>
          </div>
        )}
      </section>

      <div className="mt-8 flex justify-center">
        <button
          type="button"
          disabled={!gate.ok || busy}
          onClick={onGenerate}
          className="rounded-full bg-rose-400 px-8 py-4 text-base font-semibold tracking-wide text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Generating…" : "🎬 Generate Music Video"}
        </button>
      </div>
      {status ? <p className="mt-4 text-center text-sm text-zinc-400">{status}</p> : null}
      {exportUrl ? (
        <p className="mt-3 text-center">
          <a className="text-sm text-rose-200 underline" href={exportUrl} download={exportName}>
            Download video
          </a>
        </p>
      ) : null}
    </main>
  );
}
