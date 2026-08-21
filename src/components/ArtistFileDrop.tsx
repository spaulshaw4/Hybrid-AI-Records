import { useEffect, useRef, useState } from "react";
import { useAutosavedState } from "@/lib/form-autosave";
import { Upload, File as FileIcon, Check, X, Loader2, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SERVICES } from "@/lib/services";
import { useSupportRequest } from "@/lib/support-request";
import { logUploadAction } from "@/lib/upload-audit";
import { requestUploadTicket } from "@/lib/artist-uploads.functions";


const BUCKET = "artist-uploads";
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB per file
const MAX_FILES = 8;


/** What the drop zone is collecting: audio-production files or video assets. */
export type UploadKind = "audio" | "video";

type AcceptedFormat = { ext: string; note: string };

/**
 * Exactly the formats promised in the Pricing FAQ: WAV/AIFF at 24-bit or
 * higher, 320kbps MP3 or M4A for vocals, plus reference/requirement files.
 */
const AUDIO_FORMATS: AcceptedFormat[] = [
  { ext: ".wav", note: "Preferred — 24-bit / 44.1kHz or higher" },
  { ext: ".aiff", note: "Preferred — 24-bit / 44.1kHz or higher" },
  { ext: ".aif", note: "Preferred — 24-bit / 44.1kHz or higher" },
  { ext: ".mp3", note: "Accepted — 320kbps" },
  { ext: ".m4a", note: "Accepted — high bitrate" },
  { ext: ".flac", note: "Accepted — lossless reference" },
  { ext: ".zip", note: "Reference bundle" },
  { ext: ".pdf", note: "Requirements / lyrics" },
  { ext: ".txt", note: "Requirements / lyrics" },
  { ext: ".docx", note: "Requirements / lyrics" },
  { ext: ".doc", note: "Requirements / lyrics" },
  { ext: ".png", note: "Artwork reference" },
  { ext: ".jpg", note: "Artwork reference" },
  { ext: ".jpeg", note: "Artwork reference" },
];

/**
 * Video packages need the finished master audio plus visual source material:
 * footage, stills, brand assets and a treatment/storyboard.
 */
const VIDEO_FORMATS: AcceptedFormat[] = [
  { ext: ".mp4", note: "Preferred footage — H.264/H.265, 1080p or 4K" },
  { ext: ".mov", note: "Preferred footage — ProRes or H.264" },
  { ext: ".m4v", note: "Accepted footage" },
  { ext: ".webm", note: "Accepted footage" },
  { ext: ".wav", note: "Final master audio for the edit" },
  { ext: ".mp3", note: "Reference mix — 320kbps" },
  { ext: ".png", note: "Logo / still / brand asset" },
  { ext: ".jpg", note: "Still or lookbook image" },
  { ext: ".jpeg", note: "Still or lookbook image" },
  { ext: ".zip", note: "Footage or asset bundle" },
  { ext: ".pdf", note: "Treatment / storyboard / shot list" },
  { ext: ".txt", note: "Treatment notes" },
  { ext: ".docx", note: "Treatment / storyboard" },
  { ext: ".doc", note: "Treatment / storyboard" },
];

const FORMAT_HINT: Record<UploadKind, string> = {
  audio: "Send WAV, AIFF, MP3, M4A, FLAC, ZIP, PDF, TXT, DOC/DOCX, PNG or JPG.",
  video:
    "Send MP4, MOV, M4V or WEBM footage, WAV/MP3 master audio, PNG/JPG stills or logos, and a PDF/DOC treatment. ZIP large asset bundles.",
};


/** Revision rounds included with each tier, mirroring the revision policy. */
const ROUNDS_BY_SLUG: Record<string, number> = {
  foundation: 1,
  "visual-push": 2,
  "full-hybrid": 3,
};

const REVISION_TYPES = [
  { id: "mix", label: "Mix balance / EQ" },
  { id: "master", label: "Master loudness" },
  { id: "arrangement", label: "Timing or arrangement" },
  { id: "visual", label: "Video or artwork text" },
] as const;

type UploadItem = {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  /** Short headline shown next to the file row. */
  error?: string;
  /** Plain-language explanation of what to do about it. */
  errorHint?: string;
};

/** Reference codes look like HAR-1042 — anything else never matches an order. */
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{2,}$/;

/**
 * Turns a storage rejection into language an artist can act on. Storage returns
 * generic errors, so we separate the two real causes — the folder doesn't match
 * a live order reference, or the signed-in account isn't allowed to write there
 * — from ordinary network or duplicate-name failures.
 */
function describeUploadError(error: { message?: string; name?: string; statusCode?: string } | null) {
  const raw = `${error?.message ?? ""} ${(error as { statusCode?: string } | null)?.statusCode ?? ""}`.toLowerCase();

  if (raw.includes("already exists") || raw.includes("duplicate") || raw.includes("409")) {
    return {
      error: "A file with that name is already filed",
      hint: "Rename the file (add a take number or date) and upload it again.",
    };
  }
  if (
    raw.includes("row-level security") ||
    raw.includes("violates") ||
    raw.includes("unauthorized") ||
    raw.includes("permission") ||
    raw.includes("403") ||
    raw.includes("401")
  ) {
    return {
      error: "Upload blocked — reference code not recognised",
      hint:
        "Files can only be filed against a live order reference. Check the code on your submission confirmation email (for example HAR-1042). If the code is correct, your account may not have access to that order — reply to your confirmation email and we'll unlock it.",
    };
  }
  if (raw.includes("payload") || raw.includes("413") || raw.includes("too large")) {
    return {
      error: "File rejected by the server as too large",
      hint: "Keep each file under 200 MB, or send a compressed ZIP bundle instead.",
    };
  }
  if (raw.includes("network") || raw.includes("fetch") || raw.includes("timeout")) {
    return {
      error: "Connection dropped during upload",
      hint: "Check your connection and try that file again — nothing was saved.",
    };
  }
  return {
    error: "Upload couldn't be completed",
    hint: "Try again in a moment. If it keeps failing, reply to your confirmation email with the file attached.",
  };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
}

function extensionOf(name: string) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

/**
 * Pre-support intake: artists send vocals, reference tracks, or a requirements
 * doc in the formats listed in the Pricing FAQ, and log revision requests
 * against the package tier they bought.
 */
export function ArtistFileDrop({ kind = "audio" }: { kind?: UploadKind } = {}) {
  const acceptedFormats = kind === "video" ? VIDEO_FORMATS : AUDIO_FORMATS;
  const acceptAttr = acceptedFormats.map((f) => f.ext).join(",");
  const formatHint = FORMAT_HINT[kind];

  const inputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  // Autosaved: an order reference, email, tier and notes survive a refresh
  // or a back navigation. Selected files themselves cannot be persisted by the
  // browser, so only the typed inputs are restored.
  const [reference, setReference] = useAutosavedState("upload.reference", "");
  /** Contact email the order was placed with — proves ownership of the reference. */
  const [contactEmail, setContactEmail] = useAutosavedState("upload.email", "");

  const [tier, setTier] = useAutosavedState(`upload.${kind}.tier`, SERVICES[0]!.slug);
  const [round, setRound] = useAutosavedState(`upload.${kind}.round`, 1);
  const [types, setTypes] = useAutosavedState<string[]>(`upload.${kind}.types`, []);
  const [revisionNotes, setRevisionNotes] = useAutosavedState(`upload.${kind}.notes`, "");
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Second line under the notice explaining how to unblock the upload. */
  const [noticeHint, setNoticeHint] = useState<string | null>(null);
  /** Marks the reference field invalid when it's the reason an upload stopped. */
  const [referenceInvalid, setReferenceInvalid] = useState(false);
  const [sendingNotes, setSendingNotes] = useState(false);
  const [notesSent, setNotesSent] = useState(false);

  const busy = items.some((i) => i.status === "uploading");
  const completed = items.filter((i) => i.status === "done").length;
  const pkg = SERVICES.find((s) => s.slug === tier) ?? SERVICES[0]!;
  const includedRounds = ROUNDS_BY_SLUG[pkg.slug] ?? 1;
  const notesReady = revisionNotes.trim().length >= 10;

  // Feed the single persistent WhatsApp CTA with the current selections.
  const { setRequest } = useSupportRequest();
  useEffect(() => {
    setRequest({ tierSlug: tier, round, notes: revisionNotes });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, round, revisionNotes]);



  /**
   * Storage refuses anonymous writes entirely. Uploads are authorised by the
   * server, which checks the reference code against the order's contact email
   * before issuing a single-use signed upload URL.
   */
  const referenceCode = () => reference.trim().replace(/[\\/]/g, "");

  /** Shows a two-line notice: what went wrong, then what to do next. */
  function flagNotice(message: string, hint: string | null, blameReference = false) {
    setNotice(message);
    setNoticeHint(hint);
    setReferenceInvalid(blameReference);
    if (blameReference) {
      requestAnimationFrame(() => referenceInputRef.current?.focus());
    }
  }

  /**
   * Blocks the upload before it starts when the reference or contact email is
   * missing or clearly malformed, so the artist gets a precise reason instead
   * of a server refusal.
   */
  function referenceProblem(action: string) {
    const code = referenceCode();
    if (!code) {
      return {
        message: `Add your order reference code before ${action}.`,
        hint: "It's on your submission confirmation email and looks like HAR-1042. Uploads are filed against that order, so we can't accept files without it.",
      };
    }
    if (!REFERENCE_PATTERN.test(code)) {
      return {
        message: `That reference code doesn't look right, so ${action} was stopped.`,
        hint: "Use the code exactly as it appears on your confirmation email — letters, numbers and dashes only, for example HAR-1042.",
      };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail.trim())) {
      return {
        message: `Add the email address on the order before ${action}.`,
        hint: "We match it against the order behind that reference code — only the artist who booked it can send files.",
      };
    }
    return null;
  }

  /**
   * Uploads one blob through a server-authorised signed URL. Returns a storage
   * style error object so the existing failure messaging keeps working.
   */
  async function uploadViaTicket(
    fileName: string,
    body: Blob | File,
    contentType?: string,
  ): Promise<{ path: string; error: { message: string } | null }> {
    const fallbackPath = `${referenceCode()}/${fileName}`;
    let ticket: Awaited<ReturnType<typeof requestUploadTicket>>;
    try {
      ticket = await requestUploadTicket({
        data: { reference: referenceCode(), email: contactEmail.trim(), fileName },
      });
    } catch {
      return { path: fallbackPath, error: { message: "network error while authorising the upload" } };
    }
    if (!ticket.ok) {
      return {
        path: fallbackPath,
        error: { message: ticket.reason === "unverified" ? "unauthorized" : ticket.message },
      };
    }
    const { error } = await supabase.storage
      .from(BUCKET)
      .uploadToSignedUrl(ticket.path, ticket.token, body, contentType ? { contentType } : undefined);
    return { path: ticket.path, error: error ? { message: error.message } : null };
  }

  const toggleType = (id: string) =>

    setTypes((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));

  async function uploadFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const problem = referenceProblem("uploading");
    if (problem) {
      flagNotice(problem.message, problem.hint, true);
      return;
    }
    const files = Array.from(fileList).slice(0, MAX_FILES);
    if (fileList.length > MAX_FILES) {
      flagNotice(
        `Only the first ${MAX_FILES} files were queued.`,
        "Upload the rest in a second batch once these finish.",
      );
    } else {
      setNotice(null);
      setNoticeHint(null);
      setReferenceInvalid(false);
    }



    for (const file of files) {
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
      setItems((prev) => [...prev, { id, name: file.name, size: file.size, status: "uploading" }]);

      const ext = extensionOf(file.name);
      if (!acceptedFormats.some((f) => f.ext === ext)) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "error",
                  error: `${ext || "That file type"} isn't accepted`,
                  errorHint: formatHint,
                }
              : i,
          ),
        );

        continue;
      }

      if (file.size > MAX_BYTES) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "error",
                  error: "File is larger than 200 MB",
                  errorHint: "Bounce a smaller file or split the session into a ZIP bundle.",
                }
              : i,
          ),
        );
        continue;
      }

      const { path, error } = await uploadViaTicket(file.name, file);


      const failure = error ? describeUploadError(error) : null;
      setItems((prev) =>
        prev.map((i) =>
          i.id === id
            ? failure
              ? { ...i, status: "error", error: failure.error, errorHint: failure.hint }
              : { ...i, status: "done" }
            : i,
        ),
      );
      void logUploadAction({
        action: "upload",
        objectPath: path,
        fileName: file.name,
        fileSize: file.size,
        referenceCode: referenceCode(),
        outcome: failure ? "failed" : "success",
        errorMessage: failure ? failure.error : null,
      });
      if (failure) {
        flagNotice(
          `${file.name}: ${failure.error}.`,
          failure.hint,
          failure.error.includes("reference code"),
        );
      }
    }

    if (inputRef.current) inputRef.current.value = "";
  }

  /** Revision notes travel with the files as a plain-text brief in the same folder. */
  async function sendRevisionNotes() {
    if (!notesReady || sendingNotes) return;
    const problem = referenceProblem("sending these revision notes");
    if (problem) {
      flagNotice(problem.message, problem.hint, true);
      return;
    }
    setSendingNotes(true);
    setNotesSent(false);

    const selectedTypes = REVISION_TYPES.filter((t) => types.includes(t.id)).map((t) => t.label);
    const body = [
      `Reference: ${referenceCode()}`,
      `Package tier: ${pkg.title} (${includedRounds} revision round${includedRounds === 1 ? "" : "s"} included)`,
      `Revision round: ${round} of ${includedRounds}`,
      `Areas: ${selectedTypes.length ? selectedTypes.join(", ") : "Not specified"}`,
      `Submitted: ${new Date().toISOString()}`,
      "",
      "Notes:",
      revisionNotes.trim(),
      "",
    ].join("\n");

    const { path, error } = await uploadViaTicket(
      `revision-request-${pkg.slug}-round-${round}.txt`,
      new Blob([body], { type: "text/plain" }),
      "text/plain",
    );


    setSendingNotes(false);
    void logUploadAction({
      action: "upload",
      objectPath: path,
      fileName: `revision-request-round-${round}.txt`,
      fileSize: body.length,
      referenceCode: referenceCode(),
      outcome: error ? "failed" : "success",
      errorMessage: error ? error.message : null,
      details: { kind: "revision-notes", round },
    });
    if (error) {
      const failure = describeUploadError(error);
      flagNotice(
        `Revision notes not sent — ${failure.error.toLowerCase()}.`,
        failure.hint,
        failure.error.includes("reference code"),
      );
      return;
    }
    setNotice(null);
    setNoticeHint(null);
    setReferenceInvalid(false);
    setNotesSent(true);
  }

  return (
    <div
      id="send-files"
      aria-labelledby="send-files-title"
      className="mt-px scroll-mt-20 bg-background/25 p-8 backdrop-blur-sm"
    >
      <div className="eyebrow">
        <span className="text-[#e11d2e]">/</span> <span className="text-white">Send files</span>
      </div>
      <h3 id="send-files-title" className="mt-3 font-display text-2xl font-semibold text-white">
        {kind === "video"
          ? "Upload Master Audio, Footage & Treatment"
          : "Upload Vocals, References & Revision Requests"}
      </h3>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        {kind === "video"
          ? "Send your final master audio, any footage or stills for the cut, your logo, and a short treatment or shot list. This is a one-shoot deal with 0 revisions and delivery is final, so send the locked assets. Everything lands in a private studio inbox."
          : "Send the exact formats listed in the FAQ above — WAV or AIFF at 24-bit / 44.1kHz or higher, 320kbps MP3, or M4A — plus references and a requirements doc. Then log your revision notes against the package tier you bought. Everything lands in a private studio inbox."}
      </p>


      <div className="mt-6 max-w-3xl">
        <label
          htmlFor="upload-reference"
          className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
        >
          Order reference code (required)
        </label>
        <input
          ref={referenceInputRef}
          id="upload-reference"
          type="text"
          required
          value={reference}
          maxLength={80}
          onChange={(e) => {
            setReference(e.target.value);
            setReferenceInvalid(false);
          }}
          placeholder="e.g. HAR-1042"
          aria-invalid={referenceInvalid || undefined}
          aria-describedby={
            referenceInvalid ? "upload-reference-hint upload-notice" : "upload-reference-hint"
          }
          className={`mt-2 w-full border bg-background/60 px-4 py-3 text-sm text-white outline-none placeholder:text-muted-foreground focus:border-[#e11d2e] ${
            referenceInvalid ? "border-[#e11d2e]" : "border-border"
          }`}
        />
        <p id="upload-reference-hint" className="mt-2 text-xs text-muted-foreground">
          Use the reference code from your submission confirmation — uploads are filed against it.
        </p>

        <label
          htmlFor="upload-contact-email"
          className="mt-5 block font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
        >
          Email on the order (required)
        </label>
        <input
          id="upload-contact-email"
          type="email"
          required
          value={contactEmail}
          maxLength={200}
          autoComplete="email"
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="you@example.com"
          aria-describedby="upload-email-hint"
          className="mt-2 w-full border border-border bg-background/60 px-4 py-3 text-sm text-white outline-none placeholder:text-muted-foreground focus:border-[#e11d2e]"
        />
        <p id="upload-email-hint" className="mt-2 text-xs text-muted-foreground">
          We match this against the order behind your reference code, so only the artist who booked
          the session can send files.
        </p>





        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void uploadFiles(e.dataTransfer.files);
          }}
          className={`mt-4 border border-dashed p-8 text-center transition-colors ${
            dragging ? "border-[#e11d2e] bg-[#e11d2e]/5" : "border-border bg-background/40"
          }`}
        >
          <Upload size={22} aria-hidden className="mx-auto text-[#e11d2e]" />
          <p className="mt-3 text-sm text-white">Drag &amp; drop your files here, or</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="mt-3 inline-flex items-center gap-2 bg-[#e11d2e] px-5 py-2.5 font-display text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <Loader2 size={15} aria-hidden className="animate-spin" /> : null}
            {busy ? "Uploading…" : "Choose files"}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={acceptAttr}
            className="sr-only"
            onChange={(e) => void uploadFiles(e.target.files)}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Up to 200 MB per file · {MAX_FILES} files at a time
          </p>
          {kind === "video" ? (
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
              Footage over 200 MB: upload it to Drive, Dropbox or WeTransfer and paste the link in
              your project notes instead. Send the final master audio (WAV) plus any logos, stills
              and a short treatment so the edit matches your vision.
            </p>
          ) : null}
        </div>

        <ul className="mt-3 flex flex-wrap gap-2">
          {acceptedFormats.map((f) => (

            <li
              key={f.ext}
              title={f.note}
              className="border border-border px-2 py-1 font-mono text-[11px] uppercase text-white/70"
            >
              {f.ext.replace(".", "")}
            </li>
          ))}
        </ul>

        {notice ? (
          <div
            id="upload-notice"
            role="alert"
            className="mt-3 border border-[#e11d2e]/60 bg-[#e11d2e]/10 px-3 py-2"
          >
            <p className="text-xs font-semibold text-[#e11d2e]">{notice}</p>
            {noticeHint ? <p className="mt-1 text-xs text-white/80">{noticeHint}</p> : null}
          </div>
        ) : null}

        {items.length > 0 ? (
          <ul className="mt-4 divide-y divide-border border border-border">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 bg-background/40 px-4 py-3">
                <FileIcon size={15} aria-hidden className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm text-white">{item.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatSize(item.size)}
                </span>
                <span className="shrink-0">
                  {item.status === "uploading" ? (
                    <Loader2 size={15} aria-hidden className="animate-spin text-muted-foreground" />
                  ) : item.status === "done" ? (
                    <Check size={15} aria-hidden className="text-[#3b6fe0]" />
                  ) : (
                    <X size={15} aria-hidden className="text-[#e11d2e]" />
                  )}
                  <span className="sr-only">
                    {item.status === "done"
                      ? "Uploaded"
                      : item.status === "error"
                        ? `${item.error ?? "Failed"}. ${item.errorHint ?? ""}`
                        : "Uploading"}
                  </span>
                </span>
                {item.status === "error" && item.error ? (
                  <span className="max-w-[18rem] shrink-0 text-right text-xs text-[#e11d2e]">
                    {item.error}
                    {item.errorHint ? (
                      <span className="block text-white/70">{item.errorHint}</span>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <p aria-live="polite" className="mt-4 text-sm text-white/75">
          {completed > 0
            ? `${completed} file${completed === 1 ? "" : "s"} received. Mention your reference “${
                referenceCode()
              }” when you contact support and we'll match them to your project.`
            : "Nothing uploaded yet."}
        </p>

        {/* Revision requests per package tier — video is a one-shoot deal, so no rounds exist. */}
        {kind === "video" ? (
          <div className="mt-8 border border-border bg-background/40 p-5">
            <h4 className="font-display text-lg font-semibold text-white">
              One-shoot deal · no returns
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Video packages include 0 revisions and delivery is final once the cut is sent. All
              video sales are final — no returns, refunds, or exchanges. Lock your treatment,
              footage, and master audio before production starts.
            </p>

          </div>
        ) : (
        <div className="mt-8 border border-border bg-background/40 p-5">

          <h4 className="font-display text-lg font-semibold text-white">Revision request</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Send all notes for a round together — that&rsquo;s how a round is counted in the
            revision policy above.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="rev-tier" className="text-xs font-medium text-white">
                Package tier
              </label>
              <select
                id="rev-tier"
                value={tier}
                onChange={(e) => {
                  setTier(e.target.value);
                  setRound(1);
                  setNotesSent(false);
                }}
                className="mt-1 w-full border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-[#e11d2e]"
              >
                {SERVICES.map((s) => (
                  <option key={s.slug} value={s.slug} className="bg-background text-white">
                    {s.title} — {ROUNDS_BY_SLUG[s.slug] ?? 1} round
                    {(ROUNDS_BY_SLUG[s.slug] ?? 1) === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="rev-round" className="text-xs font-medium text-white">
                Which round is this?
              </label>
              <select
                id="rev-round"
                value={round}
                onChange={(e) => setRound(Number(e.target.value))}
                className="mt-1 w-full border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none focus:border-[#e11d2e]"
              >
                {Array.from({ length: includedRounds }, (_, i) => i + 1).map((r) => (
                  <option key={r} value={r} className="bg-background text-white">
                    Round {r} of {includedRounds}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <fieldset className="mt-4">
            <legend className="text-xs font-medium text-white">What needs adjusting?</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {REVISION_TYPES.map((t) => {
                const on = types.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleType(t.id)}
                    className={`border px-3 py-1.5 text-xs font-medium transition-colors ${
                      on
                        ? "border-[#e11d2e] bg-[#e11d2e]/15 text-white"
                        : "border-border text-white/70 hover:border-white/50 hover:text-white"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <label htmlFor="rev-notes" className="mt-4 block text-xs font-medium text-white">
            Revision notes
          </label>
          <textarea
            id="rev-notes"
            rows={4}
            maxLength={1500}
            value={revisionNotes}
            onChange={(e) => {
              setRevisionNotes(e.target.value);
              setNotesSent(false);
            }}
            placeholder="e.g. Vocal up 1.5dB in the chorus, less reverb on verse 2, tighten the last hook."
            className="mt-1 w-full resize-y border border-border bg-background/60 px-3 py-2 text-sm leading-relaxed text-white outline-none focus:border-[#e11d2e]"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {revisionNotes.trim().length}/1500 characters
          </p>

          <button
            type="button"
            onClick={() => void sendRevisionNotes()}
            disabled={!notesReady || sendingNotes}
            className="mt-4 inline-flex items-center gap-2 bg-[#e11d2e] px-5 py-3 text-sm font-semibold uppercase tracking-widest text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sendingNotes ? (
              <Loader2 size={15} aria-hidden className="animate-spin" />
            ) : (
              <Send size={15} aria-hidden />
            )}
            {sendingNotes ? "Sending…" : "Send revision request"}
          </button>

          <p aria-live="polite" className="mt-3 text-sm text-white/75">
            {notesSent
              ? `Round ${round} notes logged for ${pkg.title}. We'll return this round within 2–3 business days.`
              : notesReady
                ? "Ready to send."
                : "Add at least a sentence of notes to send this round."}
          </p>
        </div>
        )}

      </div>
    </div>
  );
}
