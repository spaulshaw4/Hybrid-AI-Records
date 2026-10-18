import { useState, type ChangeEvent, type DragEvent } from "react";
import { videoStudioGate } from "@/lib/video-studio";

type VideoStudioProps = {
  audioName: string | null;
  characterPreview: string | null;
  vision: string;
  autoWrite: boolean;
  busy: boolean;
  status: string | null;
  exportUrl: string | null;
  exportName: string;
  onMasterFile: (file: File | null) => void;
  onCharacterImage: (file: File | null) => void;
  onVision: (value: string) => void;
  onAutoWrite: (value: boolean) => void;
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
  autoWrite,
  busy,
  status,
  exportUrl,
  exportName,
  onMasterFile,
  onCharacterImage,
  onVision,
  onAutoWrite,
  onGenerate,
}: VideoStudioProps) {
  const gate = videoStudioGate({ hasAudio: Boolean(audioName), vision });

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
        <h2 className="text-xs font-semibold tracking-[0.18em] text-zinc-300">
          3. The Script / Vision
        </h2>
        <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4">
          <label className="block text-sm text-zinc-200" htmlFor="script-vision">
            The Script & Vision
          </label>
          <textarea
            id="script-vision"
            value={vision}
            onChange={(event) => onVision(event.target.value)}
            rows={6}
            placeholder="Describe what happens in the video (or type your concept, and Claude will build the scene script for you)..."
            className="mt-3 w-full resize-y bg-transparent text-base leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <button
            type="button"
            aria-pressed={autoWrite}
            onClick={() => onAutoWrite(!autoWrite)}
            className={`mt-3 rounded-full border px-4 py-2 text-sm ${
              autoWrite
                ? "border-rose-300/50 bg-rose-400/15 text-rose-100"
                : "border-white/15 text-zinc-300"
            }`}
          >
            Auto-Write with Claude
          </button>
        </div>
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
