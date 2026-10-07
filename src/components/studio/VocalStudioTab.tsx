import { useRef, useState, type FormEvent } from "react";

import { supabase } from "@/integrations/supabase/client";

const GENDERS = ["Male Vocal", "Female Vocal", "Duet"] as const;
const TEXTURE_TAGS = ["gritty", "baritone", "close-mic", "soulful", "dry"] as const;
const SECTION_TAGS = ["[Verse]", "[Chorus]", "[Bridge]", "[Outro]"] as const;

type VocalGender = (typeof GENDERS)[number];

const fieldClass =
  "w-full bg-transparent text-sm text-white outline-none placeholder:text-zinc-500";

function customerError(message: string): string {
  if (/wavespeed|aimusic|sonic|mureka/i.test(message)) return "Vocal render failed.";
  return message;
}

export function VocalStudioTab() {
  const lyricsRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [vocalGender, setVocalGender] = useState<VocalGender>("Male Vocal");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [error, setError] = useState("");

  const styleTags = TEXTURE_TAGS.filter((tag) => selectedTags.includes(tag)).join(", ");
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

  const toggleTag = (tag: string) => {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
    );
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
          styleTags,
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
      aria-label="Vocals and toplines"
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
        <span className="text-xs font-semibold text-zinc-400">Texture and mood</span>
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Texture and mood">
          {TEXTURE_TAGS.map((tag) => {
            const selected = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleTag(tag)}
                className={
                  selected
                    ? "rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400"
                    : "rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-white/5"
                }
              >
                {tag}
              </button>
            );
          })}
        </div>
      </div>

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
