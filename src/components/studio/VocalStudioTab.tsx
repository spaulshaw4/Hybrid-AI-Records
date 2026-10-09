import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Sparkles } from "lucide-react";

import MyPromptsModal, { type SavedPromptItem } from "@/components/studio/MyPromptsModal";
import TemplatesModal from "@/components/studio/TemplatesModal";
import { DurationSlider } from "@/components/studio/DurationSlider";
import { isAudioVaultHttpsUrl } from "@/components/studio/CharacterModal";
import { supabase } from "@/integrations/supabase/client";
import type { TrackTemplate } from "@/data/murekaTemplates";

const PROMPT_RECORDS_KEY = "hybrid_prompt_records";
const VENDOR_WORD = /wavespeed|aimusic|sonic|mureka|replicate|fable/i;

export type VocalStudioReference = {
  label?: string;
  personaId?: string;
  vocalAudioUrl?: string;
};

export type VisualSongDraft = {
  revision: number;
  title: string;
  lyrics: string;
  tags: string;
  /** Audio passes append tags. Visual passes replace title, lyrics, and style. */
  pass?: "audio";
  acousticTags?: string;
};

/** Trim, drop one trailing comma, then join. Skip when the new tags already end the style. */
export function appendAcousticTags(current: string, newTags: string): string {
  const next = newTags.trim();
  if (!next) return current;
  const trimmed = current.trim();
  if (!trimmed) return next;
  const cleaned = trimmed.endsWith(",") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  if (cleaned.endsWith(next)) return cleaned;
  return `${cleaned}, ${next}`;
}

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

export function VocalGenderCard({
  vocalsEnabled,
  gender,
  onChange,
}: {
  vocalsEnabled: boolean;
  gender: "male" | "female";
  onChange: (gender: "male" | "female") => void;
}) {
  const choose = (next: "male" | "female") => {
    if (!vocalsEnabled) return;
    onChange(next);
  };
  const tone = (selected: boolean) =>
    selected && vocalsEnabled ? "bg-red-600 text-white" : "bg-zinc-800/80 text-zinc-400";

  return (
    <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="whitespace-nowrap text-xs font-semibold tracking-wider text-zinc-300 uppercase">
            Vocal Gender
          </span>
        </div>
      </div>
      <div
        role="group"
        aria-label="Vocal gender"
        className={`grid grid-cols-2 gap-2${vocalsEnabled ? "" : " opacity-35 pointer-events-none"}`}
      >
        <button
          type="button"
          disabled={!vocalsEnabled}
          aria-pressed={gender === "female"}
          onClick={() => choose("female")}
          className={`w-full rounded-md px-3 py-2 text-xs font-bold ${tone(gender === "female")}`}
        >
          Female
        </button>
        <button
          type="button"
          disabled={!vocalsEnabled}
          aria-pressed={gender === "male"}
          onClick={() => choose("male")}
          className={`w-full rounded-md px-3 py-2 text-xs font-bold ${tone(gender === "male")}`}
        >
          Male
        </button>
      </div>
    </div>
  );
}

export function VocalStudioTab({
  reference,
  vocalReference = null,
  songDraft = null,
}: {
  reference?: VocalStudioReference;
  vocalReference?: ReactNode;
  songDraft?: VisualSongDraft | null;
} = {}) {
  const [title, setTitle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [styleText, setStyleText] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [trackLength, setTrackLength] = useState(180);
  const [submitting, setSubmitting] = useState(false);
  const [styleAssistBusy, setStyleAssistBusy] = useState(false);
  const [lyricsAssistBusy, setLyricsAssistBusy] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [error, setError] = useState("");
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [isMyPromptsOpen, setIsMyPromptsOpen] = useState(false);
  const [promptRecords, setPromptRecords] = useState<SavedPromptItem[]>([]);
  const draftSeeded = useRef(false);

  useEffect(() => {
    setPromptRecords(readPromptRecords());
  }, []);

  useEffect(() => {
    if (!songDraft) return;
    if (songDraft.pass === "audio") {
      const draft = songDraft;
      setStyleText((current) => {
        if (!current.trim()) return draft.tags;
        if (!draft.acousticTags) return current;
        return appendAcousticTags(current, draft.acousticTags);
      });
      if (!draftSeeded.current) {
        setTitle((current) => (current.trim() ? current : draft.title));
        setLyrics((current) => (current.trim() ? current : draft.lyrics));
        draftSeeded.current = true;
      }
      return;
    }
    setTitle(songDraft.title);
    setLyrics(songDraft.lyrics);
    setStyleText(songDraft.tags);
    draftSeeded.current = true;
  }, [songDraft]);

  const submitDisabled = submitting || !lyrics.trim();
  const styleAssistLabel = styleText.trim() ? "Expand Style" : lyrics.trim() ? "Match Lyrics" : "Surprise Me";
  const lyricsAssistLabel = lyricsAssistBusy
    ? lyrics.trim()
      ? "Polishing..."
      : "Drafting..."
    : lyrics.trim()
      ? "Format & Polish"
      : "Studio Ghostwriter";

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
    setGender(tmpl.recommendedGender === "female" ? "female" : "male");
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
    const referenceAudioUrl =
      reference?.vocalAudioUrl && isAudioVaultHttpsUrl(reference.vocalAudioUrl) ? reference.vocalAudioUrl.trim() : "";
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
          vocalGender: gender === "female" ? "Female Vocal" : "Male Vocal",
          styleTags: styleText.trim(),
          duration: trackLength,
          ...(referenceAudioUrl ? { reference_audio_url: referenceAudioUrl } : {}),
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
        className="flex flex-col gap-4"
        aria-label="With Vocals"
      >
        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/30 px-4 py-3">
          <input
            aria-label="Song title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Enter song title"
            maxLength={50}
            className={fieldClass}
          />
          <span className="text-xs text-zinc-500">{title.length}/50</span>
        </div>

        {vocalReference ?? (reference?.label ? <p className="text-xs text-zinc-300">{reference.label}</p> : null)}

        <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-bold text-white">Lyrics & Structure</span>
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
          <textarea
            aria-label="Lyrics"
            value={lyrics}
            onChange={(event) => setLyrics(event.target.value)}
            placeholder="Enter lyrics..."
            rows={5}
            className={`${fieldClass} resize-y`}
          />
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          <VocalGenderCard vocalsEnabled gender={gender} onChange={setGender} />
          <div className="min-w-[280px] flex-[1_1_280px] rounded-xl border border-white/10 bg-black/30 p-3.5">
            <DurationSlider value={trackLength} onChange={setTrackLength} />
          </div>
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
          className="flex h-12 w-full items-center justify-center rounded-lg border border-red-500 bg-red-600 text-sm font-bold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800"
        >
          {submitting ? "Synthesizing & Vaulting..." : "Render Master Record"}
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
