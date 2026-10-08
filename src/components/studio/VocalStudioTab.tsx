import { useEffect, useRef, useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";

import MyPromptsModal, { type SavedPromptItem } from "@/components/studio/MyPromptsModal";
import TemplatesModal from "@/components/studio/TemplatesModal";
import { DurationSlider } from "@/components/studio/DurationSlider";
import { supabase } from "@/integrations/supabase/client";
import type { TrackTemplate } from "@/data/murekaTemplates";

const GENDERS = ["Male Vocal", "Female Vocal", "Duet"] as const;
const SECTION_TAGS = ["[Verse]", "[Chorus]", "[Bridge]", "[Outro]"] as const;
const PROMPT_RECORDS_KEY = "hybrid_prompt_records";
const VENDOR_WORD = /wavespeed|aimusic|sonic|mureka|replicate|fable/i;

type VocalGender = (typeof GENDERS)[number];

export type VocalStudioReference = {
  label?: string;
  personaId?: string;
  vocalAudioUrl?: string;
};

const fieldClass =
  "w-full bg-transparent text-sm text-white outline-none placeholder:text-zinc-500";
const compactActionClass =
  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border disabled:cursor-not-allowed disabled:opacity-60";
const badgeActionClass = `${compactActionClass} border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20`;
const secondaryActionClass = `${compactActionClass} bg-transparent text-zinc-300 hover:bg-white/5 border-white/10`;

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

function readPromptRecords(): SavedPromptItem[] {
  try {
    const raw = localStorage.getItem(PROMPT_RECORDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedPromptItem => {
      if (!item || typeof item !== "object") return false;
      const row = item as Partial<SavedPromptItem>;
      return (
        typeof row.id === "string" &&
        typeof row.title === "string" &&
        typeof row.prompt === "string" &&
        typeof row.timestamp === "number" &&
        typeof row.isBookmarked === "boolean"
      );
    });
  } catch {
    return [];
  }
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

export function VocalStudioTab({ reference }: { reference?: VocalStudioReference } = {}) {
  const lyricsRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [styleText, setStyleText] = useState("");
  const [vocalGender, setVocalGender] = useState<VocalGender>("Male Vocal");
  const [trackLength, setTrackLength] = useState(180);
  const [submitting, setSubmitting] = useState(false);
  const [styleAssistBusy, setStyleAssistBusy] = useState(false);
  const [lyricsAssistBusy, setLyricsAssistBusy] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [error, setError] = useState("");
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [isMyPromptsOpen, setIsMyPromptsOpen] = useState(false);
  const [promptRecords, setPromptRecords] = useState<SavedPromptItem[]>([]);

  useEffect(() => {
    setPromptRecords(readPromptRecords());
  }, []);

  const submitDisabled = submitting || !lyrics.trim();
  const styleAssistLabel = styleText.trim() ? "Expand Style" : lyrics.trim() ? "Match Lyrics" : "Surprise Me";
  const lyricsAssistLabel = lyricsAssistBusy
    ? lyrics.trim()
      ? "Polishing..."
      : "Drafting..."
    : lyrics.trim()
      ? "Format & Polish"
      : "Studio Ghostwriter";

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

  const handleApplyTemplate = (tmpl: TrackTemplate) => {
    setStyleText(tmpl.prompt);
    setVocalGender(tmpl.recommendedGender === "female" ? "Female Vocal" : "Male Vocal");
  };

  const saveRecords = (updated: SavedPromptItem[]) => {
    setPromptRecords(updated);
    localStorage.setItem(PROMPT_RECORDS_KEY, JSON.stringify(updated));
  };

  const handleManualBookmark = () => {
    const nextPrompt = styleText.trim();
    if (!nextPrompt) return;
    const existing = promptRecords.find((item) => item.prompt === nextPrompt);
    if (existing) {
      saveRecords(
        promptRecords.map((item) =>
          item.id === existing.id ? { ...item, isBookmarked: !item.isBookmarked } : item,
        ),
      );
      return;
    }
    const entry: SavedPromptItem = {
      id: Date.now().toString(),
      title: title.trim() || "Untitled",
      prompt: nextPrompt,
      timestamp: Date.now(),
      isBookmarked: true,
    };
    saveRecords([entry, ...promptRecords]);
  };

  const handleToggleBookmark = (id: string) => {
    saveRecords(
      promptRecords.map((item) => (item.id === id ? { ...item, isBookmarked: !item.isBookmarked } : item)),
    );
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitDisabled) return;
    setSubmitting(true);
    setError("");
    setTaskId("");
    const personaId = reference?.personaId?.trim() ?? "";
    const vocalAudioUrl = reference?.vocalAudioUrl?.trim() ?? "";
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
          duration: trackLength,
          ...(vocalAudioUrl ? { vocalAudioUrl } : {}),
          ...(personaId ? { personaId } : {}),
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
    <>
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
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Musical Style</span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={styleAssistBusy}
                onClick={() => void handleStyleAssist()}
                className={badgeActionClass}
              >
                {styleAssistBusy ? "Designing..." : styleAssistLabel}
              </button>
              <button type="button" onClick={() => setIsTemplatesOpen(true)} className={secondaryActionClass}>
                Templates
              </button>
              <button
                type="button"
                onClick={() => {
                  setPromptRecords(readPromptRecords());
                  setIsMyPromptsOpen(true);
                }}
                className={secondaryActionClass}
              >
                Saved
              </button>
            </div>
          </div>
          <textarea
            id="vocal-style"
            aria-label="Style"
            value={styleText}
            onChange={(event) => setStyleText(event.target.value)}
            placeholder="Genre, mood, or instruments — or try Match Lyrics or Surprise Me"
            maxLength={1000}
            rows={4}
            className={`${fieldClass} resize-y`}
          />
          <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 text-xs text-zinc-500">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleManualBookmark}
                title="Bookmark this prompt"
                aria-label="Bookmark this prompt"
                className="border-none bg-transparent text-sm text-rose-500"
              >
                🔖
              </button>
              <button
                type="button"
                onClick={() => setStyleText("")}
                aria-label="Clear style"
                className="border-none bg-transparent text-sm text-zinc-500"
              >
                🗑️
              </button>
            </div>
            <span>{styleText.length}/1000</span>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
          <DurationSlider value={trackLength} onChange={setTrackLength} />
        </div>

        {reference?.label ? <p className="text-xs text-zinc-300">{reference.label}</p> : null}

        <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-bold text-white">Lyrics</span>
            <div className="flex flex-wrap items-center gap-2">
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
              </div>
              <button
                type="button"
                disabled={lyricsAssistBusy}
                onClick={() => void handleLyricsAssist()}
                className={badgeActionClass}
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {lyricsAssistLabel}
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
          {submitting ? "Synthesizing..." : "Render Track"}
        </button>
      </form>
      <TemplatesModal
        isOpen={isTemplatesOpen}
        onClose={() => setIsTemplatesOpen(false)}
        onSelectTemplate={handleApplyTemplate}
      />
      <MyPromptsModal
        isOpen={isMyPromptsOpen}
        onClose={() => setIsMyPromptsOpen(false)}
        items={promptRecords}
        onSelectPrompt={(loadedPrompt) => setStyleText(loadedPrompt)}
        onToggleBookmark={handleToggleBookmark}
      />
    </>
  );
}
