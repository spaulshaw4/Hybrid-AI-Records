import { useMemo, useRef, useState } from "react";
import { Check, FileText, Languages, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { submitLyrics } from "@/lib/lyrics-submission.functions";
import type { ServicePackage } from "@/lib/services";

const LANGUAGES = [
  "English",
  "Spanish",
  "Portuguese",
  "French",
  "German",
  "Lithuanian",
  "Yoruba",
  "Igbo",
  "Hausa",
  "Swahili",
  "Arabic",
  "Hindi",
  "Japanese",
  "Korean",
];

const ACCEPT = ".txt,.md,.rtf,.pdf,.doc,.docx,.pages";
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * "Lyrics Only (any language)" intake: paste the lyrics, attach a document, or
 * both — plus the language they're written in so we cast the right vocalist.
 */
export function LyricsSubmissionForm({
  pkg,
  className = "",
}: {
  pkg?: ServicePackage | null;
  className?: string;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [artist, setArtist] = useState("");
  const [email, setEmail] = useState("");
  const [language, setLanguage] = useState("English");
  const [otherLanguage, setOtherLanguage] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const resolvedLanguage = useMemo(
    () => (language === "Other" ? otherLanguage.trim() : language),
    [language, otherLanguage],
  );

  function pickFile(list: FileList | null) {
    const next = list?.[0] ?? null;
    if (!next) return;
    if (next.size > MAX_BYTES) {
      setError("That lyrics file is over 10 MB. Send a document, not audio.");
      return;
    }
    setError(null);
    setFile(next);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!artist.trim()) return setError("Artist name is required.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
      return setError("Enter a valid contact email.");
    if (!resolvedLanguage) return setError("Tell us what language the lyrics are written in.");
    if (!lyrics.trim() && !file) return setError("Paste your lyrics or attach a lyrics file.");

    setBusy(true);
    try {
      const result = await submitLyrics({
        data: {
          artist: artist.trim(),
          email: email.trim(),
          language: resolvedLanguage,
          lyricsText: lyrics.trim() || undefined,
          notes: notes.trim() || undefined,
          packageSlug: pkg?.slug,
          packageLabel: pkg?.title,
          fileName: file?.name,
        },
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      if (file && result.upload) {
        const { error: uploadError } = await supabase.storage
          .from("artist-uploads")
          .uploadToSignedUrl(result.upload.path, result.upload.token, file, {
            contentType: file.type || "application/octet-stream",
          });
        if (uploadError) {
          setError(
            "Your lyrics text was saved, but the file didn't upload. Try attaching it again or email it to us.",
          );
          return;
        }
      }

      setSent(true);
      toast.success("Lyrics received", {
        description: `We'll review your ${resolvedLanguage} lyrics and reply by email.`,
      });
    } catch {
      setError("Something went wrong sending your lyrics. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div
        className={`border border-border-strong bg-background/40 p-6 backdrop-blur-sm ${className}`}
      >
        <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[#4b8bff]">
          <Check size={14} aria-hidden /> Lyrics submitted
        </p>
        <p className="mt-3 text-sm leading-relaxed text-white/80">
          Thanks — we have your <span className="text-white">{resolvedLanguage}</span> lyrics
          {file ? " and your attached document" : ""}. We'll email{" "}
          <span className="text-white">{email}</span> once our roster vocalist is assigned.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className={`border border-border-strong bg-background/40 p-6 backdrop-blur-sm ${className}`}
    >
      <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        <FileText size={14} aria-hidden className="text-[#e11d2e]" />
        Lyrics Only — send your words
      </p>
      <p className="mt-3 text-sm leading-relaxed text-white/80">
        No video chat needed. Paste your lyrics, attach a document, or both — our in-house roster
        performs the vocals in the language you write in.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Artist name
          </span>
          <input
            required
            maxLength={120}
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            className="mt-2 w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Contact email
          </span>
          <input
            required
            type="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-2 w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
          />
        </label>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            <Languages size={12} aria-hidden /> Lyrics language
          </span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="mt-2 w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
            <option value="Other">Other (type it in)</option>
          </select>
        </label>
        {language === "Other" && (
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Which language?
            </span>
            <input
              maxLength={64}
              value={otherLanguage}
              onChange={(e) => setOtherLanguage(e.target.value)}
              placeholder="e.g. Tagalog"
              className="mt-2 w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
            />
          </label>
        )}
      </div>

      <label className="mt-4 block">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Your lyrics
        </span>
        <textarea
          rows={10}
          maxLength={20000}
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          placeholder={"Verse 1…\nChorus…"}
          className="mt-2 w-full whitespace-pre-wrap border border-border bg-background/60 px-3 py-3 font-mono text-sm leading-relaxed text-white outline-none focus:border-[#4b8bff]"
        />
        <span className="mt-1 block text-right font-mono text-[10px] text-muted-foreground">
          {lyrics.length}/20000
        </span>
      </label>

      <div className="mt-4">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Or attach a lyrics document (optional)
        </span>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          onChange={(e) => pickFile(e.target.files)}
          className="sr-only"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="inline-flex min-h-11 items-center gap-2 border border-border-strong px-4 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:border-white"
          >
            <Paperclip size={13} aria-hidden /> Choose file
          </button>
          {file && (
            <span className="inline-flex items-center gap-2 border border-border px-3 py-2 text-xs text-white/80">
              {file.name}
              <button
                type="button"
                aria-label="Remove attached lyrics file"
                onClick={() => {
                  setFile(null);
                  if (fileInput.current) fileInput.current.value = "";
                }}
                className="text-white/60 transition-colors hover:text-[#e11d2e]"
              >
                <X size={13} aria-hidden />
              </button>
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          .txt, .md, .rtf, .pdf, .doc, .docx or .pages — up to 10 MB.
        </p>
      </div>

      <label className="mt-5 block">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Notes (optional)
        </span>
        <textarea
          rows={3}
          maxLength={1000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Reference tracks, tempo, vocal tone, pronunciation notes."
          className="mt-2 w-full border border-border bg-background/60 px-3 py-3 text-sm text-white outline-none focus:border-[#4b8bff]"
        />
      </label>

      {error && (
        <p role="alert" className="mt-4 text-xs font-medium text-[#e11d2e]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 bg-[#e11d2e] px-6 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-[#c4162a] disabled:cursor-not-allowed disabled:bg-[#e11d2e]/40"
      >
        {busy ? "Sending…" : "Submit my lyrics"}
      </button>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        You keep 100% ownership of your lyrics — we only use them to produce your track.
      </p>
    </form>
  );
}
