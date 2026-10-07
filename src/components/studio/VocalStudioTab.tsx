import { useRef, useState, type FormEvent } from "react";

import { supabase } from "@/integrations/supabase/client";

const GENDERS = ["Male Vocal", "Female Vocal", "Duet"] as const;
const SECTION_TAGS = ["[Verse]", "[Chorus]", "[Bridge]", "[Outro]"] as const;
const VENDOR_WORD = /wavespeed|aimusic|sonic|mureka|replicate|fable/i;

type VocalGender = (typeof GENDERS)[number];
type VocalFileSpec = { ext: "wav" | "mp3"; contentType: "audio/wav" | "audio/mpeg" };

const fieldClass =
  "w-full bg-transparent text-sm text-white outline-none placeholder:text-zinc-500";
const assistClass =
  "rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60";

function customerError(message: string): string {
  if (/api[_-]?key|api[_-]?token|authorization/i.test(message)) return "AI request failed.";
  if (!VENDOR_WORD.test(message)) return message;
  const cleaned = message
    .replace(/wavespeed|aimusic|sonic|mureka|replicate|fable/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,:;])/g, "$1")
    .trim();
  if (cleaned.length < 12) return "AI request failed.";
  return cleaned;
}

function vocalFileSpec(file: File): VocalFileSpec | null {
  const match = file.name.trim().match(/\.(wav|mp3)$/i);
  if (!match) return null;
  const ext = match[1]!.toLowerCase() as "wav" | "mp3";
  const type = file.type.trim().toLowerCase();
  if (type && type !== "application/octet-stream") {
    const wavTypes = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);
    const mp3Types = new Set(["audio/mpeg", "audio/mp3"]);
    if (ext === "wav" && !wavTypes.has(type)) return null;
    if (ext === "mp3" && !mp3Types.has(type)) return null;
  }
  return { ext, contentType: ext === "wav" ? "audio/wav" : "audio/mpeg" };
}

type CoproducerData = {
  ok: boolean;
  style?: string;
  prompt?: string;
  lyrics?: string;
  result?: string;
  error?: string;
  message?: string;
};

async function studioBearer(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Same coproducer POST shape EnginePage uses: action, body keys, bearer, non-JSON errors. */
async function postCoproducer(body: Record<string, string>): Promise<CoproducerData> {
  const accessToken = await studioBearer();
  const res = await fetch("/api/ai/coproducer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const rawText = await res.text();
  let data: Omit<CoproducerData, "ok"> = {};
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (parsed && typeof parsed === "object") {
      data = parsed as Omit<CoproducerData, "ok">;
    }
  } catch {
    throw new Error(`Server returned non-JSON (${res.status}): ${rawText.slice(0, 120)}`);
  }
  return { ok: res.ok, ...data };
}

export function VocalStudioTab() {
  const lyricsRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [styleText, setStyleText] = useState("");
  const [vocalGender, setVocalGender] = useState<VocalGender>("Male Vocal");
  const [vocalAudioUrl, setVocalAudioUrl] = useState("");
  const [referenceName, setReferenceName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [styleAssistBusy, setStyleAssistBusy] = useState(false);
  const [lyricsAssistBusy, setLyricsAssistBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [error, setError] = useState("");

  const submitDisabled = submitting || !lyrics.trim();

  const insertSection = (marker: string) => {
    const token = `${marker}\n`;
    const el = lyricsRef.current;
    setLyrics((current) => {
      const start = el?.selectionStart ?? current.length;
      const end = el?.selectionEnd ?? current.length;
      const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
      const caret = start + token.length;
      requestAnimationFrame(() => {
        if (!el) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
      return next;
    });
  };

  const handleStyleAssist = async () => {
    if (styleAssistBusy) return;
    setStyleAssistBusy(true);
    setError("");
    try {
      const data = await postCoproducer({
        action: "enhance_style",
        prompt: styleText,
        lyrics,
      });
      const enhanced = (data.style || data.prompt || "").trim();
      if (!data.ok || !enhanced) {
        throw new Error(
          data.error || data.message || (data.ok ? "Style enhancement returned an empty prompt." : "AI request failed"),
        );
      }
      setStyleText(enhanced);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setError(customerError(message || "AI request failed"));
    } finally {
      setStyleAssistBusy(false);
    }
  };

  const handleLyricsAssist = async () => {
    if (lyricsAssistBusy) return;
    const draft = lyrics;
    const style = styleText;
    const hasDraft = draft.trim().length > 0;
    setLyricsAssistBusy(true);
    setError("");
    try {
      const data = await postCoproducer(
        hasDraft
          ? { action: "format_lyrics", lyrics: draft, genre: style }
          : { action: "generate_lyrics", topic: style.trim() || "Overcoming the storm", genre: style },
      );
      const nextLyrics = data.lyrics || data.result || "";
      if (!data.ok || !nextLyrics.trim()) {
        throw new Error(data.error || data.message || "AI request failed");
      }
      setLyrics(nextLyrics);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setError(customerError(message || "AI request failed"));
    } finally {
      setLyricsAssistBusy(false);
    }
  };

  const handleVocalFile = async (file: File | null) => {
    if (!file) return;
    const spec = vocalFileSpec(file);
    if (!spec) {
      setError("Upload a .wav or .mp3 file.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const { data } = await supabase.auth.getSession();
      const owner = data.session?.user?.id?.trim() ?? "";
      if (!owner) {
        setError("Sign in to upload a vocal reference.");
        return;
      }
      const id = crypto.randomUUID();
      const path = `vocal-references/${owner}/${id}.${spec.ext}`;
      const { error: uploadError } = await supabase.storage.from("audio-vault").upload(path, file, {
        contentType: spec.contentType,
        upsert: false,
      });
      if (uploadError) {
        setError(customerError(uploadError.message || "Vocal reference upload failed."));
        return;
      }
      const { data: published } = supabase.storage.from("audio-vault").getPublicUrl(path);
      const url = published.publicUrl?.trim() ?? "";
      if (!url.startsWith("https://")) {
        setError("Vocal reference upload failed.");
        return;
      }
      setVocalAudioUrl(url);
      setReferenceName(file.name);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setError(customerError(message || "Vocal reference upload failed."));
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitDisabled) return;
    setSubmitting(true);
    setError("");
    setTaskId("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token?.trim() ?? "";
      const res = await fetch("/api/vocals/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          title,
          lyrics,
          vocalGender,
          styleTags: styleText.trim(),
          ...(vocalAudioUrl ? { vocalAudioUrl } : {}),
        }),
      });
      const data = (await res.json()) as { success?: boolean; taskId?: string; error?: string };
      if (!res.ok || !data.taskId) {
        setError(customerError(data.error || "Vocal render failed."));
        return;
      }
      setTaskId(data.taskId);
    } catch {
      setError("Vocal render failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="flex flex-col gap-3.5"
      aria-label="With Vocals"
    >
      <label className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/30 p-3.5">
        <span className="text-xs font-semibold text-zinc-400">Track title</span>
        <input
          aria-label="Track title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Track title"
          maxLength={120}
          className={fieldClass}
        />
      </label>

      <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
        <span className="text-xs font-semibold text-zinc-400">Vocal gender</span>
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Vocal gender">
          {GENDERS.map((gender) => {
            const selected = vocalGender === gender;
            return (
              <button
                key={gender}
                type="button"
                aria-pressed={selected}
                onClick={() => setVocalGender(gender)}
                className={
                  selected
                    ? "rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400"
                    : "rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-white/5"
                }
              >
                {gender}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="vocal-style" className="text-xs font-semibold text-zinc-400">
            Style
          </label>
          <button
            type="button"
            aria-label="Claude style assist"
            disabled={styleAssistBusy}
            onClick={() => void handleStyleAssist()}
            className={assistClass}
          >
            {styleAssistBusy ? "Claude..." : "Claude"}
          </button>
        </div>
        <textarea
          id="vocal-style"
          aria-label="Style"
          value={styleText}
          onChange={(event) => setStyleText(event.target.value)}
          placeholder="Style keywords"
          rows={4}
          className={`${fieldClass} resize-y`}
        />
      </div>

      <label className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/30 p-3.5">
        <span className="text-xs font-semibold text-zinc-400">Upload Vocal Audio / Reference</span>
        <input
          aria-label="Upload Vocal Audio / Reference"
          type="file"
          accept=".wav,.mp3,audio/wav,audio/mpeg"
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            event.target.value = "";
            void handleVocalFile(file);
          }}
          className="text-xs text-zinc-300 file:mr-3 file:rounded-lg file:border file:border-white/10 file:bg-transparent file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-zinc-200"
        />
        {uploading ? <span className="text-xs text-zinc-400">Uploading...</span> : null}
        {referenceName ? (
          <span className="text-xs text-zinc-300" role="status">
            {referenceName}
          </span>
        ) : null}
      </label>

      <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-bold text-white">Lyrics</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Lyric sections">
            {SECTION_TAGS.map((marker) => (
              <button
                key={marker}
                type="button"
                onClick={() => insertSection(marker)}
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20"
              >
                {marker}
              </button>
            ))}
            <button
              type="button"
              aria-label="Claude lyrics assist"
              disabled={lyricsAssistBusy}
              onClick={() => void handleLyricsAssist()}
              className={assistClass}
            >
              {lyricsAssistBusy ? "Claude..." : "Claude"}
            </button>
          </div>
        </div>
        <textarea
          ref={lyricsRef}
          aria-label="Lyrics"
          value={lyrics}
          onChange={(event) => setLyrics(event.target.value)}
          placeholder="Write the topline"
          rows={8}
          className={`${fieldClass} resize-y`}
        />
      </div>

      <p className="text-xs font-semibold text-zinc-400">This render uses 1 Hybrid Token</p>

      {error ? (
        <p role="alert" className="rounded-lg border border-red-900 bg-red-950/80 px-4 py-3 text-sm text-red-100">
          {error}
        </p>
      ) : null}
      {taskId ? (
        <p role="status" className="text-sm text-zinc-200">
          Task {taskId}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitDisabled}
        className="w-full rounded-lg border border-red-500 bg-red-600 py-3.5 text-sm font-bold text-white shadow-lg shadow-red-900/40 hover:bg-red-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800 disabled:shadow-none"
      >
        {submitting ? "Rendering vocal..." : "Render vocal"}
      </button>
    </form>
  );
}
